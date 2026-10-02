// Diagnostic reproductions: intentionally outside the regular passing e2e suite.
// Assertions describe expected reader behavior; failures are audit evidence.
const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const Zip = require('../../../public/jszip.min.js');
let epub;
test.beforeAll(async () => {
  const zip = await Zip.loadAsync(fs.readFileSync(path.resolve(__dirname, '../fixtures/three-chapters.epub')));
  const opf = await zip.file('OEBPS/content.opf').async('string');
  zip.file('OEBPS/content.opf', opf.replace('Three Chapter Test Book', 'Reader Audit Long Book'));
  const paragraphs = Array.from({length: 100}, (_, i) => `<p>Audit paragraph ${i + 1}. ${'A long chapter must scroll and turn pages without skipping text or trapping the controls. '.repeat(6)}</p>`).join('');
  zip.file('OEBPS/chapter1.xhtml', `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>Chapter One</title></head><body><h1>Chapter One</h1>${paragraphs}</body></html>`);
  epub = await zip.generateAsync({type: 'nodebuffer'});
});
test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.locator('#username-input').fill('admin');
  await page.locator('#passphrase-input').fill('correct horse battery');
  await page.locator('#login-btn').click();
  await expect(page.locator('#dropzone')).toHaveJSProperty('hidden', false);
  if (!(await page.evaluate(() => library.some(item => item.name === 'Reader Audit Long Book')))) {
    await page.locator('#file-input').setInputFiles({name: 'reader-audit-long.epub', mimeType: 'application/epub+zip', buffer: epub});
    await expect.poll(()=>page.evaluate(()=>library.some(item=>item.name==='Reader Audit Long Book'))).toBe(true);
    if (!(await page.evaluate(()=>isMobileShell()))) await expect.poll(()=>page.evaluate(()=>readerNavigationReady)).toBe(true);
    await page.evaluate(() => showShelf());
  }
  await page.evaluate(() => { settings.layout = 'paginated'; settings.gestures = {swipe:true, edge:true, center:true}; library.find(item=>item.name==='Reader Audit Long Book').lastLocationCfi=null; });
  await page.evaluate(() => openBook(library.find(item=>item.name==='Reader Audit Long Book').id));
  await expect.poll(()=>page.evaluate(()=>readerNavigationReady)).toBe(true);
});
async function scrolled(page) {
  await page.evaluate(()=>setLayout('scrolled'));
  await expect.poll(()=>page.evaluate(()=>readerNavigationReady)).toBe(true);
  await expect(page.locator('#epub-scroll-container')).toBeVisible();
}
test('desktop real wheel over chapter text scrolls the book', async ({page})=>{
  await scrolled(page);
  console.log('AUDIT desktop scroll geometry', await page.evaluate(()=>{const s=rendition.manager.container;return {scrollTop:s.scrollTop,scrollHeight:s.scrollHeight,height:s.clientHeight,bodyOverflow:rendition.getContents()[0].window.getComputedStyle(rendition.getContents()[0].document.documentElement).overscrollBehavior};}));
  const before=await page.locator('#epub-scroll-container').evaluate(s=>s.scrollTop);
  await page.mouse.move(720,400); await page.mouse.wheel(0,600);
  await expect.poll(()=>page.locator('#epub-scroll-container').evaluate(s=>s.scrollTop)).toBeGreaterThan(before);
});
test('desktop click on chapter text restores controls after scroll hides them', async({page})=>{
  await scrolled(page);
  await page.locator('#epub-scroll-container').evaluate(s=>{s.scrollTop=400;});
  await expect(page.locator('#app')).toHaveClass(/chrome-hidden/);
  await page.mouse.click(720,400);
  await expect(page.locator('#app')).not.toHaveClass(/chrome-hidden/);
});
test('desktop wheel remains effective after controls become immersive', async({page})=>{
  await scrolled(page);
  await page.locator('#epub-scroll-container').evaluate(s=>{s.scrollTop=400;});
  await expect(page.locator('#app')).toHaveClass(/chrome-hidden/);
  await page.mouse.move(720,400); await page.mouse.wheel(0,500);
  await expect.poll(()=>page.locator('#epub-scroll-container').evaluate(s=>s.scrollTop)).toBeGreaterThan(400);
});
test('desktop scroll-chain A/B isolates the iframe overscroll rule', async({page})=>{
  await scrolled(page);
  const before=await page.locator('#epub-scroll-container').evaluate(s=>s.scrollTop);
  await page.mouse.move(720,400); await page.mouse.wheel(0,600);
  await page.waitForTimeout(300);
  const blocked=await page.locator('#epub-scroll-container').evaluate(s=>s.scrollTop);
  await page.evaluate(()=>{for(const content of rendition.getContents()) for(const element of [content.document.documentElement, content.document.body]) element.style.setProperty('overscroll-behavior','auto','important');});
  await page.mouse.wheel(0,600);
  await expect.poll(()=>page.locator('#epub-scroll-container').evaluate(s=>s.scrollTop)).toBeGreaterThan(blocked);
  console.log('AUDIT scroll-chain A/B',{before,blocked,after:await page.locator('#epub-scroll-container').evaluate(s=>s.scrollTop)});
});
test('search settles when a query changes during delayed indexing',async({page})=>{
  await page.evaluate(async()=>{
    bookTextIndex.clear(); bookSearchIndex.clear();
    const section=book.spine.get(0), load=section.load.bind(section);
    section.load=async(...args)=>{await new Promise(resolve=>setTimeout(resolve,700));return load(...args);};
    const first=runSearch('paragraph');
    await new Promise(resolve=>setTimeout(resolve,50));
    const second=runSearch('scroll');
    await Promise.all([first,second]);
  });
  await expect(page.locator('#search-status')).not.toHaveText('Searching…');
});
test('Copy and Share preserve the full selected passage',async({page})=>{
  const text=await page.evaluate(()=>{
    const content=rendition.getContents()[0], paragraph=content.document.querySelector('p');
    const range=content.document.createRange(); range.selectNodeContents(paragraph);
    const selection=content.window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
    const original=selection.toString().trim();
    onTextSelected(library.find(item=>item.id===currentBookId),getSafeCfi(),content);
    return {original,actionText:selectionText()};
  });
  console.log('AUDIT selection lengths',{selected:text.original.length,copied:text.actionText.length});
  expect(text.actionText).toBe(text.original);
});
test('read aloud starts at a visible later page rather than the chapter heading',async({page})=>{
  const spoken=await page.evaluate(async()=>{
    if (!('speechSynthesis' in window)) Object.defineProperty(window,'speechSynthesis',{value:{}});
    await turnPage('next'); await turnPage('next'); await turnPage('next');
    let firstText=null; startTtsWithQueue=queue=>{firstText=queue[0]?.text;};
    startTtsFromVisible(); return {firstText,cfi:getSafeCfi(),scrollLeft:rendition.manager.container.scrollLeft};
  });
  console.log('AUDIT visible audio start',spoken);
  expect(spoken.firstText).toBeTruthy();
  expect(spoken.firstText).not.toBe('Chapter One');
});
test('Stop cancels a pending audio continuation after a page turn',async({page})=>{
  const continuation=await page.evaluate(async()=>{
    Object.defineProperty(window,'speechSynthesis',{configurable:true,value:{cancel(){},speak(){},getVoices(){return [];}}});
    window.SpeechSynthesisUtterance=class {constructor(text){this.text=text;}};
    const content=rendition.getContents()[0], block=content.document.querySelector('p');
    ttsQueue=[{text:'Last sentence in the queue.',element:block,doc:content.document}]; ttsIndex=0;
    speakCurrentTtsItem(); ttsUtterance.onend();
    await readerNavigationTail; await new Promise(resolve=>setTimeout(resolve,20));
    stopTts(); let restarts=0; startTtsWithQueue=()=>{restarts++;};
    await new Promise(resolve=>setTimeout(resolve,500));
    return restarts;
  });
  console.log('AUDIT audio restart after Stop',continuation);
  expect(continuation).toBe(0);
});
test('layout change preserves annotation responses still loading for the same book',async({page})=>{
  const annotations=await page.evaluate(async()=>{
    const entry=getCurrentEntry(), cfi=getSafeCfi(); showShelf(); entry.bookmarks=[]; entry.highlights=[];
    let releaseBookmarks,releaseHighlights;
    api.getBookmarks=()=>new Promise(resolve=>{releaseBookmarks=resolve;});
    api.getHighlights=()=>new Promise(resolve=>{releaseHighlights=resolve;});
    await openBook(entry.id);
    setLayout('scrolled');
    releaseBookmarks([{id:901,cfi,chapter:'Saved bookmark'}]);
    releaseHighlights([{id:902,cfi_range:cfi,excerpt:'Saved passage'}]);
    await new Promise(resolve=>setTimeout(resolve,300));
    return {bookmarks:entry.bookmarks.length,highlights:entry.highlights.length};
  });
  console.log('AUDIT annotations after layout race',annotations);
  expect(annotations).toEqual({bookmarks:1,highlights:1});
});
test('failed highlight deletion remains recoverable rather than silently disappearing',async({page})=>{
  const state=await page.evaluate(async()=>{
    const entry=getCurrentEntry(), cfi=getSafeCfi();
    entry.highlights=[{id:903,cfi,excerpt:'Saved passage',color:'#F2D94E'}]; window.currentHighlights=entry.highlights;
    api.removeHighlight=async()=>{throw new Error('Simulated connection failure');};
    onHighlightClicked(entry,cfi); await removeCurrentHighlight();
    return {visible:entry.highlights.length,exported:window.currentHighlights.length};
  });
  console.log('AUDIT failed deletion and stale export',state);
  expect(state.visible).toBe(1);
});
test('highlight export reflects successful removal from the reader',async({page})=>{
  const state=await page.evaluate(async()=>{
    const entry=getCurrentEntry(), cfi=getSafeCfi();
    entry.highlights=[{id:904,cfi,excerpt:'Removed passage',color:'#F2D94E'}]; window.currentHighlights=entry.highlights;
    api.removeHighlight=async()=>({ok:true});
    onHighlightClicked(entry,cfi); await removeCurrentHighlight();
    return {visible:entry.highlights.length,exported:window.currentHighlights.length};
  });
  console.log('AUDIT successful deletion and stale export',state);
  expect(state).toEqual({visible:0,exported:0});
});
test.describe('phone native taps on a long chapter',()=>{
  test.use({viewport:{width:393,height:852},isMobile:true,hasTouch:true});
  test('visible Next page button advances within a chapter',async({page})=>{
    const before=await page.evaluate(()=>getSafeCfi());
    console.log('AUDIT phone pagination',await page.evaluate(()=>({cfi:getSafeCfi(),managerWidth:rendition.manager.container.clientWidth,iframeWidth:rendition.getContents()[0].window.innerWidth,frameRect:document.querySelector('#viewer iframe').getBoundingClientRect().toJSON()})));
    const button=await page.locator('.nav-zone.right').boundingBox();
    await page.touchscreen.tap(button.x+button.width/2,button.y+button.height/2);
    await expect.poll(()=>page.evaluate(()=>getSafeCfi())).not.toBe(before);
  });
  test('edge tap with immersive controls still advances page',async({page})=>{
    await page.evaluate(()=>enterImmersiveReading());
    const before=await page.evaluate(()=>getSafeCfi());
    await page.touchscreen.tap(388,350);
    await expect.poll(()=>page.evaluate(()=>getSafeCfi())).not.toBe(before);
  });
  test('native tap in iframe edge zone advances within chapter',async({page})=>{
    const before=await page.evaluate(()=>getSafeCfi());
    await page.evaluate(()=>{window.auditTouch=[];const doc=rendition.getContents()[0].document;for(const type of ['touchstart','touchmove','touchend','touchcancel','click'])doc.addEventListener(type,event=>window.auditTouch.push({type,trusted:event.isTrusted,x:event.changedTouches?.[0]?.clientX,width:doc.defaultView.innerWidth,collapsed:doc.defaultView.getSelection()?.isCollapsed}));});
    await page.touchscreen.tap(330,350);
    console.log('AUDIT native iframe events',await page.evaluate(()=>window.auditTouch));
    await expect.poll(()=>page.evaluate(()=>getSafeCfi())).not.toBe(before);
  });
  test('sandbox blocks native iframe callbacks in WebKit; trusted-fixture A/B isolates it',async({page})=>{
    const errors=[]; page.on('console',message=>{if(message.type()==='error')errors.push(message.text());});
    const attach=()=>page.evaluate(()=>{window.auditClicks=0;rendition.getContents()[0].document.addEventListener('click',()=>window.auditClicks++);});
    await attach(); await page.mouse.click(190,350);
    const blocked=await page.evaluate(()=>window.auditClicks);
    console.log('AUDIT sandbox baseline', {blocked,errors});
    // Test-only security A/B on our generated fixture. No production sandbox changes.
    await page.evaluate(()=>{const original=renditionOptions;renditionOptions=()=>({...original(),allowScriptedContent:true});setLayout('scrolled');});
    await expect.poll(()=>page.evaluate(()=>readerNavigationReady)).toBe(true);
    await attach(); await page.mouse.click(190,350);
    console.log('AUDIT trusted-fixture sandbox comparison',await page.evaluate(()=>window.auditClicks));
    expect(await page.evaluate(()=>window.auditClicks)).toBeGreaterThan(blocked);
  });
  test('selection popup fits within the phone viewport',async({page})=>{
    await page.evaluate(()=>showHighlightPopup(window.innerWidth/2,200,true));
    const bounds=await page.locator('#highlight-popup').boundingBox();
    console.log('AUDIT selection popup',bounds);
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x+bounds.width).toBeLessThanOrEqual(393);
  });
  test('iframe-wide edge calculation disagrees with the visible page',async({page})=>{
    const outcome=await page.evaluate(async()=>{
      const initial=getSafeCfi(), width=rendition.getContents()[0].window.innerWidth;
      handleReaderSwipeOrTap(330,350,330,350,100,false,width,window,false);
      await readerNavigationTail;
      const wrong=getSafeCfi(); exitImmersiveReading();
      handleReaderSwipeOrTap(330,350,330,350,100,false,393,window,false);
      await readerNavigationTail;
      return {initial,width,wrong,correct:getSafeCfi()};
    });
    console.log('AUDIT edge-coordinate A/B',outcome);
    expect(outcome.wrong).toBe(outcome.initial);
    expect(outcome.correct).not.toBe(outcome.initial);
  });
  test('direct next, synthetic swipe and native click expose navigation state',async({page})=>{
    const probe=()=>page.evaluate(()=>({cfi:getSafeCfi(),ready:readerNavigationReady,lock:pageTurnLock,scrollLeft:rendition.manager.container.scrollLeft,scrollWidth:rendition.manager.container.scrollWidth,clientWidth:rendition.manager.container.clientWidth,flow:rendition.manager.settings.flow,layout:rendition.manager.layout.props,chrome:document.getElementById('app').className,element:document.elementFromPoint(388,350)?.outerHTML.slice(0,160)}));
    console.log('AUDIT before direct next',await probe());
    console.log('AUDIT direct result',await page.evaluate(()=>turnPage('next')));
    console.log('AUDIT after direct next',await probe());
    await page.locator('.nav-zone.right').click();
    await expect.poll(()=>page.evaluate(()=>pageTurnLock)).toBe(false);
    console.log('AUDIT after native click',await probe());
    const before=await page.evaluate(()=>getSafeCfi());
    await page.evaluate(()=>handleReaderSwipeOrTap(330,350,40,350,150,true,393,window,false));
    console.log('AUDIT after synthetic gesture',await probe());
    await expect.poll(()=>page.evaluate(()=>getSafeCfi())).not.toBe(before);
  });
});
