/*
 * linux.do iOS 16.2 Safari static block fix for Loon
 *
 * 修复点：iOS 16.2 WebKit 不支持 ES2022 class static initialization block：
 *   class { static { ... } }
 * 本脚本在 Loon http-response 阶段把它降级成 Safari 16.2 可解析的 static field：
 *   class { static __loon_static_N = (function(){ ... }).call(this); }
 *
 * 注意：这是运行时兼容补丁，不是完整 Babel。若站点继续使用其它 Safari 16.2 不支持的新语法，仍需继续补。
 */

(function () {
  'use strict';

  const url = ($request && $request.url) || '';
  let body = ($response && $response.body) || '';
  let headers = Object.assign({}, ($response && $response.headers) || {});

  function log(s) { try { console.log('[linux.do iOS16 fix] ' + s); } catch (_) {} }

  function finishUnchanged(reason) {
    log('unchanged: ' + reason + ' url=' + url);
    $done({});
  }

  function finishChanged(newBody, count) {
    // body 已是明文，删除压缩/长度/缓存相关头，避免客户端按旧头处理。
    for (const k of Object.keys(headers)) {
      const lk = k.toLowerCase();
      if (lk === 'content-encoding' || lk === 'content-length' || lk === 'etag') delete headers[k];
    }
    if (!headers['Content-Type'] && !headers['content-type']) headers['Content-Type'] = 'text/javascript; charset=utf-8';
    headers['Cache-Control'] = 'no-store, no-cache, must-revalidate, max-age=0';
    log('patched static blocks=' + count + ' url=' + url);
    $done({ status: $response.status, headers: headers, body: newBody });
  }

  function isIdentChar(ch) {
    return !!ch && /[A-Za-z0-9_$]/.test(ch);
  }

  function skipString(src, i, quote) {
    i++;
    while (i < src.length) {
      const c = src[i];
      if (c === '\\') { i += 2; continue; }
      if (c === quote) return i + 1;
      i++;
    }
    return i;
  }

  function skipLineComment(src, i) {
    i += 2;
    while (i < src.length && src[i] !== '\n' && src[i] !== '\r') i++;
    return i;
  }

  function skipBlockComment(src, i) {
    i += 2;
    while (i + 1 < src.length) {
      if (src[i] === '*' && src[i + 1] === '/') return i + 2;
      i++;
    }
    return i;
  }

  // 只跳过模板字符串的纯文本部分；遇到 ${ 时返回表达式起点，让外层继续扫描表达式代码。
  // 返回：{ index, expr }
  // expr=true 表示停在 ${ 的 { 之后，也就是表达式内容开头。
  function skipTemplateText(src, i) {
    i++;
    while (i < src.length) {
      const c = src[i];
      const n = src[i + 1];
      if (c === '\\') { i += 2; continue; }
      if (c === '`') return { index: i + 1, expr: false };
      if (c === '$' && n === '{') return { index: i + 2, expr: true };
      i++;
    }
    return { index: i, expr: false };
  }

  // 从 ${...} 表达式内部当前位置开始，找到对应的 }。
  // 表达式内部仍然可能有字符串、注释、模板字符串、对象字面量等。
  // 返回 } 的位置，没找到返回 -1。
  function findTemplateExprEnd(src, i) {
    let depth = 1;
    while (i < src.length) {
      const c = src[i];
      const n = src[i + 1];
      if (c === '"' || c === "'") { i = skipString(src, i, c); continue; }
      if (c === '`') {
        // 模板套模板：跳过其文本，但其 ${...} 仍按表达式递归平衡。
        i++;
        while (i < src.length) {
          const tc = src[i], tn = src[i + 1];
          if (tc === '\\') { i += 2; continue; }
          if (tc === '`') { i++; break; }
          if (tc === '$' && tn === '{') {
            const end = findTemplateExprEnd(src, i + 2);
            if (end === -1) return -1;
            i = end + 1;
            continue;
          }
          i++;
        }
        continue;
      }
      if (c === '/' && n === '/') { i = skipLineComment(src, i); continue; }
      if (c === '/' && n === '*') { i = skipBlockComment(src, i); continue; }
      if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) return i;
      }
      i++;
    }
    return -1;
  }

  function findMatchingBrace(src, openIndex) {
    let i = openIndex + 1;
    let depth = 1;
    while (i < src.length) {
      const c = src[i];
      const n = src[i + 1];
      if (c === '"' || c === "'") { i = skipString(src, i, c); continue; }
      if (c === '`') {
        // static block 内如果有模板字符串，完整跳过，包含其中 ${...}。
        i++;
        while (i < src.length) {
          const tc = src[i], tn = src[i + 1];
          if (tc === '\\') { i += 2; continue; }
          if (tc === '`') { i++; break; }
          if (tc === '$' && tn === '{') {
            const end = findTemplateExprEnd(src, i + 2);
            if (end === -1) return -1;
            i = end + 1;
            continue;
          }
          i++;
        }
        continue;
      }
      if (c === '/' && n === '/') { i = skipLineComment(src, i); continue; }
      if (c === '/' && n === '*') { i = skipBlockComment(src, i); continue; }
      if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) return i;
      }
      i++;
    }
    return -1;
  }

  function transformStaticBlocks(src) {
    let out = '';
    let i = 0;
    let count = 0;
    let templateExprEndStack = [];

    while (i < src.length) {
      const c = src[i];
      const n = src[i + 1];

      // 如果当前在模板 ${...} 表达式中，遇到表达式结束的 } 后，继续跳过模板文本部分。
      if (templateExprEndStack.length && i === templateExprEndStack[templateExprEndStack.length - 1]) {
        out += c;
        i++;
        templateExprEndStack.pop();
        const ret = skipTemplateText(src, i - 1); // 这里 i-1 是 }，不能直接用；下面手工处理更安全
        // 上面不适用，因为 skipTemplateText 期望当前位置是 `。这里直接从 i 扫到下一个 ${ 或 `。
        let j = i;
        while (j < src.length) {
          const tc = src[j], tn = src[j + 1];
          if (tc === '\\') { j += 2; continue; }
          if (tc === '`') { out += src.slice(i, j + 1); i = j + 1; break; }
          if (tc === '$' && tn === '{') {
            out += src.slice(i, j + 2);
            const end = findTemplateExprEnd(src, j + 2);
            if (end !== -1) templateExprEndStack.push(end);
            i = j + 2;
            break;
          }
          j++;
        }
        if (j >= src.length) { out += src.slice(i); i = src.length; }
        continue;
      }

      // 普通字符串/注释跳过，防止误替换其中的 static{ 文本。
      if (c === '"' || c === "'") {
        const j = skipString(src, i, c);
        out += src.slice(i, j);
        i = j;
        continue;
      }
      if (c === '/' && n === '/') {
        const j = skipLineComment(src, i);
        out += src.slice(i, j);
        i = j;
        continue;
      }
      if (c === '/' && n === '*') {
        const j = skipBlockComment(src, i);
        out += src.slice(i, j);
        i = j;
        continue;
      }
      if (c === '`') {
        // 复制模板文本；遇到 ${...} 则进入表达式，表达式内继续扫描代码。
        let j = i + 1;
        while (j < src.length) {
          const tc = src[j], tn = src[j + 1];
          if (tc === '\\') { j += 2; continue; }
          if (tc === '`') { out += src.slice(i, j + 1); i = j + 1; break; }
          if (tc === '$' && tn === '{') {
            out += src.slice(i, j + 2);
            const end = findTemplateExprEnd(src, j + 2);
            if (end !== -1) templateExprEndStack.push(end);
            i = j + 2;
            break;
          }
          j++;
        }
        if (j >= src.length) { out += src.slice(i); i = src.length; }
        continue;
      }

      // 匹配 static { ... } 或 static{...}
      if (src.slice(i, i + 6) === 'static' && !isIdentChar(src[i - 1]) && !isIdentChar(src[i + 6])) {
        let j = i + 6;
        while (j < src.length && /\s/.test(src[j])) j++;
        if (src[j] === '{') {
          const end = findMatchingBrace(src, j);
          if (end !== -1) {
            const inner = src.slice(j + 1, end);
            count++;
            out += 'static __loon_static_' + count + '=(function(){' + inner + '\n}).call(this);';
            i = end + 1;
            continue;
          }
        }
      }

      out += c;
      i++;
    }

    return { body: out, count: count };
  }

  try {
    if (!body || typeof body !== 'string') return finishUnchanged('empty-or-non-string-body');

    const ct = String(headers['Content-Type'] || headers['content-type'] || '');
    const isJs = /\.js(?:\?|$)/.test(url) || /(?:text|application)\/javascript|application\/x-javascript|text\/ecmascript/i.test(ct);
    if (!isJs) return finishUnchanged('not-js');

    if (body.indexOf('static{') === -1 && !/static\s+\{/.test(body)) {
      return finishUnchanged('no-static-block');
    }

    const ret = transformStaticBlocks(body);
    if (!ret.count || ret.body === body) return finishUnchanged('no-change');
    return finishChanged(ret.body, ret.count);
  } catch (e) {
    log('transform error: ' + (e && e.stack || e));
    $done({});
  }
})();
