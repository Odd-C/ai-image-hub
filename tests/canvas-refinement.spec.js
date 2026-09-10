const {test, expect} = require('@playwright/test');

const DEMO_URL = process.env.DEMO_URL || 'http://127.0.0.1:4173';
const sizes = [
  {name: '1440x960', width: 1440, height: 960},
  {name: '1024x900', width: 1024, height: 900},
  {name: '768x900', width: 768, height: 900},
  {name: '375x812', width: 375, height: 812},
];

async function endpointDeltas(page) {
  return page.evaluate(() => [...document.querySelectorAll('#links path[data-end-x]')].map(path => {
    const source = document.querySelector(`[data-id="${path.classList.contains('derived') ? 'request-a' : 'landscape'}"] ${path.classList.contains('derived') ? '.request-out' : '.out'}`);
    const target = document.querySelector(`[data-id="${path.classList.contains('derived') ? 'result-a' : 'request-a'}"] ${path.classList.contains('derived') ? '.derived-in' : '.in'}`);
    const viewport = document.querySelector('#viewport').getBoundingClientRect();
    const world = document.querySelector('#world');
    const matrix = new DOMMatrix(getComputedStyle(world).transform);
    const center = element => { const r = element.getBoundingClientRect(); return {x:r.left+r.width/2, y:r.top+r.height/2}; };
    const a = center(source), b = center(target);
    const startScreen = {x: viewport.left + matrix.e + Number(path.dataset.startX) * matrix.a, y: viewport.top + matrix.f + Number(path.dataset.startY) * matrix.d};
    const endScreen = {x: viewport.left + matrix.e + Number(path.dataset.endX) * matrix.a, y: viewport.top + matrix.f + Number(path.dataset.endY) * matrix.d};
    return {start: Math.hypot(startScreen.x-a.x,startScreen.y-a.y), end: Math.hypot(endScreen.x-b.x,endScreen.y-b.y)};
  }));
}

for (const size of sizes) {
  test(`responsive contract ${size.name}`, async ({page}) => {
    const errors = [];
    page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
    page.on('pageerror', error => errors.push(error.message));
    await page.setViewportSize(size);
    await page.goto(DEMO_URL, {waitUntil: 'networkidle'});
    await expect(page.locator('#minimap-map')).toHaveAttribute('data-node-count', '3');
    await expect(page.locator('#minimap-map .mini-viewport')).toHaveCount(size.width <= 420 ? 0 : 1);
    if (size.width <= 420) {
      await expect(page.locator('#minimap-toggle')).toHaveAttribute('aria-expanded', 'false');
      await page.locator('#minimap-toggle').click();
      await expect(page.locator('#minimap-map .mini-viewport')).toHaveCount(1);
    }
    if (size.width <= 768) {
      const viewport = await page.locator('#viewport').boundingBox(); expect(viewport.width).toBe(size.width);
      await page.locator('#projects-button').click(); await expect(page.locator('#project-sidebar')).toBeVisible(); await expect(page.locator('#projects-button')).toHaveAttribute('aria-expanded','true');
      await page.keyboard.press('Escape'); await expect(page.locator('#projects-button')).toHaveAttribute('aria-expanded','false');
      await page.locator('#projects-button').click(); await page.locator('#project-scrim').click({position:{x:size.width-10,y:100}}); await expect(page.locator('#projects-button')).toHaveAttribute('aria-expanded','false');
    }
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    const resources = await page.evaluate(() => performance.getEntriesByType('resource').map(r => new URL(r.name).origin));
    expect(resources.every(origin => origin === new URL(DEMO_URL).origin)).toBeTruthy();
    expect(errors).toEqual([]);
    await page.screenshot({path: `qa/${size.name}.png`, fullPage: true});
  });
}

test('geometry selection shortcuts picker context viewer and isolation', async ({page}) => {
  await page.setViewportSize({width: 1440, height: 960});
  await page.goto(DEMO_URL, {waitUntil: 'networkidle'});
  await page.locator('#zoom').click();
  let deltas = await endpointDeltas(page);
  expect(deltas.length).toBe(2);
  deltas.forEach(delta => { expect(delta.start).toBeLessThanOrEqual(1.5); expect(delta.end).toBeLessThanOrEqual(1.5); });

  const image = page.locator('[data-id="landscape"]');
  const request = page.locator('[data-id="request-a"]');
  await image.click();
  await request.locator('header').click({modifiers:['Shift']});
  await expect(image).toHaveAttribute('aria-selected', 'true');
  await expect(request).toHaveAttribute('aria-selected', 'true');
  const before = await page.evaluate(() => ['landscape','request-a'].map(id => { const n=document.querySelector(`[data-id="${id}"]`); return [parseFloat(n.style.left),parseFloat(n.style.top)]; }));
  const box = await image.boundingBox();
  await page.mouse.move(box.x+80,box.y+40); await page.mouse.down(); await page.mouse.move(box.x+130,box.y+80); await page.mouse.up();
  const after = await page.evaluate(() => ['landscape','request-a'].map(id => { const n=document.querySelector(`[data-id="${id}"]`); return [parseFloat(n.style.left),parseFloat(n.style.top)]; }));
  expect(after[0][0]-before[0][0]).toBeCloseTo(after[1][0]-before[1][0], 1);
  expect(await page.locator('.node').count()).toBe(3);
  deltas = await endpointDeltas(page); deltas.forEach(delta => { expect(delta.start).toBeLessThanOrEqual(1.5); expect(delta.end).toBeLessThanOrEqual(1.5); });


  if (await page.locator('#viewer').evaluate(el => el.open)) await page.keyboard.press('Escape');
  await page.locator('#zoom-in').click();
  deltas = await endpointDeltas(page); deltas.forEach(delta => { expect(delta.start).toBeLessThanOrEqual(1.5); expect(delta.end).toBeLessThanOrEqual(1.5); });
  await page.locator('[data-id="request-a"] [data-toggle]').click();
  await page.locator('[data-id="request-a"] [data-toggle]').click();
  await page.waitForTimeout(80);
  deltas = await endpointDeltas(page); deltas.forEach(delta => { expect(delta.start).toBeLessThanOrEqual(1.5); expect(delta.end).toBeLessThanOrEqual(1.5); });

  const fit = await page.locator('[data-id="landscape"] .frame').evaluate(el => { const img=el.querySelector('img'),r=img.getBoundingClientRect();return{fit:getComputedStyle(img).objectFit,ratio:r.width/r.height,intrinsic:img.naturalWidth/img.naturalHeight}; });
  expect(fit.fit).toBe('contain'); expect(fit.intrinsic).toBeCloseTo(3, 4); expect(fit.ratio).toBeCloseTo(3, 2);
  const portrait = await page.locator('[data-id="result-a"] .frame img').evaluate(img => ({fit:getComputedStyle(img).objectFit,intrinsic:img.naturalWidth/img.naturalHeight}));
  expect(portrait.fit).toBe('contain'); expect(portrait.intrinsic).toBeCloseTo(1/3, 4);

  await request.locator('[data-model-trigger]').click();
  await expect(request.locator('.model-menu [role="group"]')).toHaveCount(3);
  await expect(request.locator('[data-profile="libtv:legacy"]')).toBeDisabled();
  await request.locator('[data-profile="lovart:nano"]').click();
  await expect(request.locator('[data-field="combo"]')).toHaveValue('3:4|2K');

  const viewportBox=await page.locator('#viewport').boundingBox();await page.locator('#viewport').click({button:'right',position:{x:viewportBox.width-20,y:Math.min(680,viewportBox.height-20)}, force:true});
  const menu = page.locator('#context-menu'); await expect(menu).toBeVisible();
  const menuBox = await menu.boundingBox(); expect(menuBox.x+menuBox.width).toBeLessThanOrEqual(1440); expect(menuBox.y+menuBox.height).toBeLessThanOrEqual(960);
  await page.keyboard.press('Escape'); await expect(menu).toBeHidden();
  await page.keyboard.press('?'); await expect(page.locator('#shortcuts')).toBeVisible(); await page.keyboard.press('Escape');

  await image.dblclick(); await expect(page.locator('#viewer')).toBeVisible(); await expect(page.locator('#viewer img')).toHaveCSS('object-fit','contain'); await page.keyboard.press('Escape');
  await page.locator('[data-id="result-a"]').click(); await expect(page.locator('[data-id="result-a"] .details')).toContainText('生成详情');

  const oldView = await page.evaluate(() => getComputedStyle(document.querySelector('#world')).transform);
  await page.locator('#minimap-map').click({position:{x:20,y:20}});
  const newView = await page.evaluate(() => getComputedStyle(document.querySelector('#world')).transform);
  expect(newView).not.toBe(oldView);

  await page.locator('#project-sidebar [data-new]').first().click(); await page.locator('#new-project-name').fill('隔离画布乙'); await page.locator('#create-project').click();
  await expect(page.locator('.node')).toHaveCount(0); await page.locator('#add-request').click(); await expect(page.locator('.node')).toHaveCount(1);
  await page.locator('[data-project="spring"]').click(); await expect(page.locator('.node')).toHaveCount(3);
});

test('direct prompt editing action rail and sidebar geometry', async ({page}) => {
  await page.setViewportSize({width:1440,height:960});
  await page.goto(DEMO_URL,{waitUntil:'networkidle'});
  const request=page.locator('[data-id="request-a"]'), textarea=request.locator('textarea');
  await page.locator('[data-id="result-a"]').click();
  await expect(request).toHaveClass(/expanded/); await expect(request).toHaveAttribute('aria-selected','false');
  const handle=await textarea.elementHandle(); await textarea.click(); await textarea.pressSequentially('｜一次输入');
  await expect(textarea).toHaveValue('保留产品比例，使用自然侧光与克制的浅灰背景｜一次输入');
  expect(await page.evaluate(()=>document.activeElement?.tagName)).toBe('TEXTAREA'); await expect(request).toHaveAttribute('aria-selected','true');
  await request.locator('[data-model-trigger]').click(); await request.locator('[data-profile="lovart:nano"]').click();
  await request.locator('[data-field="combo"]').selectOption({label:'3:4 · 2K'});
  expect(await handle.evaluate((el)=>el.isConnected)).toBeTruthy(); await handle.focus(); await page.keyboard.type('｜继续');
  await expect(textarea).toHaveValue('保留产品比例，使用自然侧光与克制的浅灰背景｜一次输入｜继续');

  const result=page.locator('[data-id="result-a"]'), footer=result.locator('footer'), rail=result.locator('.image-actions');
  for(const action of await rail.locator('a,button').all()){await expect(action).toHaveAttribute('aria-label',/.+/);await expect(action).toHaveAttribute('title',/.+/);const box=await action.boundingBox();expect(box.width).toBeGreaterThanOrEqual(28);expect(box.height).toBeGreaterThanOrEqual(28);await expect(action.locator('svg')).toHaveCount(1)}
  const before=await footer.boundingBox(); await rail.locator('[data-open]').hover(); const hover=await footer.boundingBox(); await rail.locator('[data-delete]').focus(); const focused=await footer.boundingBox(); expect({width:hover.width,height:hover.height}).toEqual({width:before.width,height:before.height});expect({width:focused.width,height:focused.height}).toEqual({width:before.width,height:before.height});
  const overlap=await page.evaluate(()=>{const m=document.querySelector('[data-id="result-a"] footer>span').getBoundingClientRect(),a=document.querySelector('[data-id="result-a"] .image-actions').getBoundingClientRect();return m.right>a.left+.5});expect(overlap).toBeFalsy();
  await expect(rail.locator('a[download]')).toHaveAttribute('href',/demo-portrait\.svg$/);
  await rail.locator('[data-open]').click(); await expect(page.locator('#viewer')).toBeVisible(); await expect(page.locator('#viewer-original')).toHaveAttribute('href',/demo-portrait\.svg$/); await page.keyboard.press('Escape');

  const center=async()=>page.evaluate(()=>{const r=document.querySelector('#viewport').getBoundingClientRect(),s=JSON.parse(localStorage.getItem('image-hub-demo-v4')).projects.find(p=>p.id==='spring');return{x:(r.width/2-s.view.x)/s.view.z,y:(r.height/2-s.view.y)/s.view.z,width:r.width,nodes:s.nodes.map(n=>[n.id,n.x,n.y])}});
  const c1=await center(); await page.locator('#sidebar-collapse').click(); await page.waitForTimeout(50); const c2=await center(); expect(c2.width).toBeGreaterThan(c1.width); expect(Math.abs(c2.x-c1.x)).toBeLessThan(1); expect(Math.abs(c2.y-c1.y)).toBeLessThan(1); expect(c2.nodes).toEqual(c1.nodes); const ds=await endpointDeltas(page);ds.forEach(d=>{expect(d.start).toBeLessThanOrEqual(1.5);expect(d.end).toBeLessThanOrEqual(1.5)});
});
