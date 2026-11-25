import {chromium} from 'playwright';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
const [modelDir,file] = process.argv.slice(2);
const server = spawn(process.execPath,['experiments/bl010/probe.mjs',modelDir,'--serve'],
  {env:{...process.env,BL010_PORT:'0'},windowsHide:true,stdio:['ignore','pipe','inherit']});
let browser;
try {
  const data = await Promise.race([once(server.stdout,'data'),once(server,'exit').then(()=>{throw new Error('Сервер остановлен')})]);
  const url = String(data[0]).match(/http:\/\/127\.0\.0\.1:\d+\//)[0];
  browser = await chromium.launch({channel:'chrome'});
  const page = await browser.newPage();
  await page.goto(url);
  const status = page.locator('#status');
  await page.locator('input').setInputFiles(file);
  const weights = '**/v3_ctc.int8.onnx';
  await page.context().route(weights,route=>route.fulfill({status:503,body:'unavailable'}));
  await page.locator('#prepare').click();
  await status.filter({hasText:'Ошибка GigaAM'}).waitFor();
  console.log(await status.innerText());
  await page.context().unroute(weights);
  for (const model of ['GigaAM','Whisper']) {
    await page.locator('select').selectOption(model);
    await page.locator('#prepare').click();
    await status.filter({hasText:model+' готова'}).waitFor();
    await page.locator('#run').click();
    const result = page.locator('li').filter({hasText:model});
    await result.waitFor();
    console.log(await result.innerText());
  }
} finally {
  await browser?.close();
  server.kill();
}
