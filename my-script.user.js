// ==UserScript==
// @name         论文预览保存（通用版）
// @namespace    local.cnu.preview.export
// @version      2.0.0
// @description  自动识别当前附件和预览页数，保存图片版PDF；支持关闭和重新打开面板。
// @match        https://ir.cnu.edu.cn/item/itemDetail/Attachment/preview.shtml*
// @match        http://ir.cnu.edu.cn/item/itemDetail/Attachment/preview.shtml*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // Small binary PDF writer: one full-page JPEG per PDF page, preserving aspect ratio.
  function buildImagePdf(pages) {
    if (!pages.length) throw new Error('没有可保存的页面');
    const encoder = new TextEncoder();
    const chunks = [];
    const offsets = [0];
    let length = 0;
    function put(value) {
      const bytes = typeof value === 'string' ? encoder.encode(value) : value;
      chunks.push(bytes);
      length += bytes.byteLength;
    }
    function object(id, body) {
      offsets[id] = length;
      put(`${id} 0 obj\n${body}\nendobj\n`);
    }
    put('%PDF-1.4\n');
    put(new Uint8Array([37, 226, 227, 207, 211, 10]));
    object(1, '<< /Type /Catalog /Pages 2 0 R >>');
    const kids = pages.map((_, i) => `${3 + i * 3} 0 R`).join(' ');
    object(2, `<< /Type /Pages /Count ${pages.length} /Kids [${kids}] >>`);
    pages.forEach((page, i) => {
      if (!(page.width > 0 && page.height > 0) || !(page.jpeg instanceof Uint8Array)) {
        throw new Error(`第 ${i + 1} 页图片数据无效`);
      }
      const id = 3 + i * 3;
      const w = 595.28;
      const h = Number((w * page.height / page.width).toFixed(4));
      object(id, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Resources << /XObject << /Im0 ${id + 1} 0 R >> >> /Contents ${id + 2} 0 R >>`);
      offsets[id + 1] = length;
      put(`${id + 1} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${page.width} /Height ${page.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${page.jpeg.byteLength} >>\nstream\n`);
      put(page.jpeg);
      put('\nendstream\nendobj\n');
      const content = `q\n${w} 0 0 ${h} 0 0 cm\n/Im0 Do\nQ\n`;
      object(id + 2, `<< /Length ${encoder.encode(content).byteLength} >>\nstream\n${content}endstream`);
    });
    const xref = length;
    const count = 3 + pages.length * 3;
    put(`xref\n0 ${count}\n0000000000 65535 f \n`);
    for (let id = 1; id < count; id++) put(`${String(offsets[id]).padStart(10, '0')} 00000 n \n`);
    put(`trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
    return new Blob(chunks, { type: 'application/pdf' });
  }

  // Read existing preview configuration only; never evaluate source code or guess IDs.
  function detectConfig(pageUrl, source, imageUrls, liveTotal) {
    const page = new URL(pageUrl);
    const bitstreamId = page.searchParams.get('bitstreamId');
    if (!/^\d+$/.test(bitstreamId || '')) throw new Error('未识别到当前附件编号');
    const declared = source.match(/\b(?:var|let|const)\s+pager_prev_act\s*=\s*['"]?(\d+)['"]?/);
    const total = Number(liveTotal ?? declared?.[1]);
    if (!Number.isSafeInteger(total) || total <= 0) throw new Error('未识别到可用预览页数，请等正文加载后重试');
    const endpoint = '/item/itemDetail/Attachment/preview/preview_getImg.shtml';
    let template;
    for (const value of imageUrls) {
      try {
        const url = new URL(value, page);
        if (url.origin === page.origin && url.pathname === endpoint &&
            url.searchParams.get('bitstreamId') === bitstreamId && url.searchParams.get('folderName')) {
          template = url;
          break;
        }
      } catch (_) { /* Ignore unrelated or malformed image URLs. */ }
    }
    if (!template && source.includes(endpoint)) {
      const folders = [...source.matchAll(/&folderName=([^&"'\s]+)&bitstreamId=(\d+)/g)];
      const match = folders.find(entry => entry[2] === bitstreamId);
      if (match) {
        template = new URL(endpoint, page);
        template.search = new URLSearchParams({ isLarge: 'false', pageNo: '1', folderName: decodeURIComponent(match[1]), bitstreamId }).toString();
      }
    }
    if (!template) throw new Error('未识别到匹配当前附件的图片地址；此预览方式暂不支持');
    return { bitstreamId, total, template: template.href };
  }

  function safeFilename(name, config) {
    const clean = String(name).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/\.pdf$/i, '').trim().replace(/[. ]+$/, '').slice(0, 100);
    return `${clean || '论文预览'}_附件${config.bitstreamId}_${config.total}页.pdf`;
  }

  // Allows offline verification without a browser session.
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { buildImagePdf, detectConfig, safeFilename };
    return;
  }
  if (window.top !== window.self || document.getElementById('cnu-export-panel')) return;
  let config;
  function readConfig() {
    const source = [...document.scripts].filter(script => !script.src).map(script => script.textContent).join('\n');
    const images = [...document.querySelectorAll('.magazine img')].map(img => img.currentSrc || img.src);
    let liveTotal;
    try {
      const book = window.jQuery?.('.magazine');
      if (book?.turn && book.turn('is')) liveTotal = book.turn('pages');
    } catch (_) { /* Saved inline configuration is sufficient if Turn.js is not ready. */ }
    return detectConfig(location.href, source, images, liveTotal);
  }
  const pages = [];
  let running = false;
  let cancelled = false;
  let activeController;
  const panel = document.createElement('section');
  panel.id = 'cnu-export-panel';
  panel.style.cssText = 'position:fixed;right:18px;bottom:18px;z-index:2147483647;width:285px;padding:16px;background:#fff;color:#172a3a;border:1px solid #aab7c4;border-radius:10px;box-shadow:0 3px 18px #0003;font:14px/1.6 sans-serif;text-align:left';
  const heading = document.createElement('strong');
  heading.textContent = '保存论文预览';
  heading.style.display = 'block';
  heading.style.paddingRight = '24px';
  const close = document.createElement('button');
  close.type = 'button';
  close.textContent = '×';
  close.title = '收起面板；正在进行的读取会继续';
  close.setAttribute('aria-label', '收起保存面板');
  close.style.cssText = 'position:absolute;right:8px;top:8px;border:0;background:transparent;color:#526577;font:24px sans-serif;cursor:pointer';
  const reopen = document.createElement('button');
  reopen.type = 'button';
  reopen.textContent = '保存PDF';
  reopen.style.cssText = 'display:none;position:fixed;right:18px;bottom:18px;z-index:2147483647;padding:8px 13px;background:#fff;color:#172a3a;border:1px solid #aab7c4;border-radius:7px;cursor:pointer';
  close.onclick = () => { panel.style.display = 'none'; reopen.style.display = 'block'; };
  reopen.onclick = () => { panel.style.display = 'block'; reopen.style.display = 'none'; };
  const label = document.createElement('label');
  label.textContent = '文件名（可改为论文标题）';
  label.style.cssText = 'display:block;margin-top:10px';
  const filename = document.createElement('input');
  filename.type = 'text';
  filename.value = '论文预览';
  filename.style.cssText = 'display:block;box-sizing:border-box;width:100%;padding:6px;border:1px solid #aab7c4;border-radius:4px;color:#172a3a;background:white';
  label.append(filename);
  const status = document.createElement('p');
  status.textContent = '按预览图原有尺寸合成图片版PDF。点击后开始。';
  status.style.cssText = 'margin:10px 0;white-space:pre-wrap;overflow-wrap:anywhere';
  const start = document.createElement('button');
  start.textContent = '生成并保存PDF';
  const stop = document.createElement('button');
  stop.textContent = '停止';
  stop.disabled = true;
  for (const button of [start, stop]) {
    button.type = 'button';
    button.style.cssText = 'padding:7px 12px;margin-right:8px;cursor:pointer;border:1px solid #98a9bb;border-radius:5px;background:#edf4fc;color:#172a3a';
  }
  panel.append(heading, close, label, status, start, stop);
  document.body.append(panel, reopen);
  try {
    config = readConfig();
    heading.textContent = `保存论文预览 · ${config.total}页`;
  } catch (error) {
    status.textContent = error.message + '。点击生成时会重新识别。';
  }
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

  async function readPage(n) {
    const url = new URL(config.template);
    url.searchParams.set('pageNo', String(n));
    const controller = new AbortController();
    activeController = controller;
    const timer = setTimeout(() => controller.abort(), 30000);
    try {
      const response = await fetch(url, { credentials: 'same-origin', signal: controller.signal });
      if (!response.ok) throw new Error(`服务器返回 HTTP ${response.status}`);
      if (new URL(response.url).origin !== location.origin) throw new Error('请求被重定向到其他站点');
      const blob = await response.blob();
      if (/text\/|json/i.test(blob.type)) throw new Error('服务器返回了文字或登录页面，而不是图片');
      const bitmap = await createImageBitmap(blob);
      try {
        if (bitmap.width < 200 || bitmap.height < 200) throw new Error('返回图片过小，可能尚未加载完成');
        const canvas = document.createElement('canvas');
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('无法创建图片画布');
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(bitmap, 0, 0);
        const jpeg = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.98));
        const result = { width: canvas.width, height: canvas.height, jpeg: null };
        canvas.width = canvas.height = 1;
        if (!jpeg) throw new Error('图片转换失败');
        result.jpeg = new Uint8Array(await jpeg.arrayBuffer());
        return result;
      } finally {
        bitmap.close();
      }
    } finally {
      clearTimeout(timer);
      activeController = undefined;
    }
  }

  stop.onclick = () => {
    cancelled = true;
    activeController?.abort();
    status.textContent = '正在停止，已读取的页面会保留在本标签页中。';
  };
  start.onclick = async () => {
    if (running) return;
    running = true;
    cancelled = false;
    start.disabled = true;
    stop.disabled = false;
    try {
      const current = readConfig();
      if (config && (current.bitstreamId !== config.bitstreamId || current.total !== config.total ||
          new URL(current.template).searchParams.get('folderName') !== new URL(config.template).searchParams.get('folderName'))) pages.length = 0;
      config = current;
      const total = config.total;
      heading.textContent = `保存论文预览 · ${total}页`;
      for (let n = pages.length + 1; n <= total; n++) {
        if (cancelled) break;
        status.textContent = `正在读取第 ${n} / ${total} 页\n请保持本标签页打开。`;
        pages.push(await readPage(n));
        await delay(500); // Sequential requests, no parallel load on the repository.
      }
      if (cancelled) {
        status.textContent = `已停止，保留 ${pages.length} / ${total} 页。点击继续即可接着读取。`;
        return;
      }
      if (pages.length !== total) throw new Error('页数不完整，未生成文件');
      status.textContent = `${total}页已读取，正在生成PDF……`;
      await delay(50);
      if (cancelled) { status.textContent = '已停止，可点击继续保存。'; return; }
      const pdf = buildImagePdf(pages);
      const url = URL.createObjectURL(pdf);
      const link = document.createElement('a');
      link.href = url;
      link.download = safeFilename(filename.value, config);
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      status.textContent = `已生成${total}页PDF（${(pdf.size / 1048576).toFixed(1)} MB），请查看浏览器下载列表。\n可以点击右上角 × 收起面板。`;
    } catch (error) {
      status.textContent = cancelled
        ? `已停止，保留 ${pages.length} / ${config?.total ?? '?'} 页。可继续读取。`
        : `第 ${pages.length + 1} 页处理失败：${error.message}\n已保留 ${pages.length} 页，未保存缺页PDF。确认在线预览仍可用后，可点击继续重试。`;
    } finally {
      running = false;
      start.disabled = false;
      stop.disabled = true;
      start.textContent = pages.length === config?.total ? '再次保存PDF' : pages.length ? '继续生成PDF' : '生成并保存PDF';
    }
  };
})();
