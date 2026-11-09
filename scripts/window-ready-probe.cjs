const {app,BrowserWindow,session}=require('electron');
process.on('uncaughtException',error=>{console.error(error);app.exit(1);});
process.on('unhandledRejection',error=>{console.error(error);app.exit(1);});
app.disableHardwareAcceleration();
let simulatedClose = false;
BrowserWindow.prototype.show=function(){ this.probeShowRequests = (this.probeShowRequests || 0) + 1; };
BrowserWindow.prototype.focus=function(){};
const nativeSetAlwaysOnTop = BrowserWindow.prototype.setAlwaysOnTop;
BrowserWindow.prototype.setAlwaysOnTop = function () { nativeSetAlwaysOnTop.call(this, false); };
app.on('browser-window-created', (_event, window) => nativeSetAlwaysOnTop.call(window, false));
app.on('browser-window-created',(_event,window)=>window.on('close',()=>{ if (!simulatedClose) app.exit(2); }));
setTimeout(()=>app.exit(2),30000);
const {mkdtempSync,writeFileSync,readFileSync}=require('node:fs');
const {join}=require('node:path'); const {tmpdir}=require('node:os'); const {pathToFileURL}=require('node:url');
const root=join(__dirname,'..'),profile=mkdtempSync(join(tmpdir(),'netmeter-window-ready-'));
app.setPath('appData',profile);app.setPath('userData',join(profile,'user-data'));process.env.PORT='4197';
let fail=true,failed=0,delayNext=false,releaseNextLoad;const log=[];const pause=ms=>new Promise(r=>setTimeout(r,ms));
function check(name,pass,detail){if(!pass)failed++;log.push((pass?'PASS ':'FAIL ')+name+' :: '+JSON.stringify(detail));writeFileSync(join(__dirname,'window-ready-probe.log'),log.join('\n'));}
app.whenReady().then(()=>session.defaultSession.webRequest.onBeforeRequest({urls:['http://127.0.0.1:4197/*']},(details,done)=>{
  if (details.url.includes('view=settings') && delayNext) { delayNext=false;releaseNextLoad=()=>done({cancel:false});return; }
  done({cancel:fail&&details.url.includes('view=settings')});
}));
(async()=>{
  await import(pathToFileURL(join(root,'main.mjs')).href);await app.whenReady();
  let settings;
  for(let i=0;i<100;i++){settings=BrowserWindow.getAllWindows().find(w=>w.getBounds().width>=440);if(settings&&!settings.webContents.isLoading())break;await pause(100);}
  await pause(300);
  const failureText=await settings.webContents.executeJavaScript('document.body.textContent');
  check('failed settings navigation displays a readable fallback, never an unexplained black page',/设置加载失败/.test(failureText),failureText);
  const diagnostic=readFileSync(join(profile,'user-data','window-load-errors.jsonl'),'utf8');
  check('failure diagnostics do not contain addresses, keys or page URLs',diagnostic.includes('load_failed')&&!/http|secret|127\.0\.0\.1/.test(diagnostic),JSON.parse(diagnostic.split('\n')[0]));
  fail=false;delayNext=true;
  await settings.webContents.executeJavaScript('window.netmeterDesktop.openSettings()');
  for(let i=0;i<100&&!releaseNextLoad;i++)await pause(20);
  if(!releaseNextLoad)throw Error('retry_request_missing');
  simulatedClose=true;settings.close();simulatedClose=false;
  const showRequestsAfterClose=settings.probeShowRequests||0;
  releaseNextLoad();
  for(let i=0;i<100;i++){if(!settings.webContents.isLoading()&&settings.netmeterPageReady)break;await pause(50);}
  await pause(150);
  check('closing during a retry prevents a late load callback from reopening the window',!settings.netmeterShowRequested&&(settings.probeShowRequests||0)===showRequestsAfterClose&&!settings.isVisible(),{requested:settings.netmeterShowRequested,lateShowRequests:(settings.probeShowRequests||0)-showRequestsAfterClose});
  // The settings window may ask the main process to retry its own page.
  require('electron').ipcMain.emit('app:open-settings', { sender: settings.webContents });
  for(let i=0;i<100;i++){if(!settings.webContents.isLoading()&&settings.webContents.getURL().startsWith('http:'))break;await pause(100);}
  await pause(300);
  const content=await settings.webContents.executeJavaScript("({heading:document.querySelector('.settings h2')?.textContent,fields:document.querySelectorAll('#preferences input').length,bg:getComputedStyle(document.body).backgroundColor})");
  check('reopening settings retries and renders the actual settings form',content.fields>3&&content.heading==='外部控制器',content);
  check('settings has an opaque light background and a ready first frame',settings.netmeterPageReady&&content.bg==='rgb(255, 255, 255)',{ready:settings.netmeterPageReady,bg:content.bg});
  check('the settings window stays alive independently without visible test windows',!settings.isDestroyed()&&!settings.isVisible(),true);
  // Offscreen composition is explicit: never show the real settings window just to capture it.
  const captureWindow=new BrowserWindow({show:false,width:560,height:1200,backgroundColor:'#ffffff',webPreferences:{offscreen:true,backgroundThrottling:false,contextIsolation:true,sandbox:true}});
  await captureWindow.loadURL(settings.webContents.getURL());await pause(300);
  for(const language of ['zh','en']){
    await captureWindow.webContents.executeJavaScript(`(()=>{const select=document.getElementById('language');select.value='${language}';select.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await pause(150); const height=await captureWindow.webContents.executeJavaScript('document.documentElement.scrollHeight');captureWindow.setContentSize(560,Math.min(1400,height+8));await pause(150);
    writeFileSync(join(root,'docs','screenshots','settings-'+language+'.png'),(await captureWindow.webContents.capturePage(undefined, { stayHidden: true })).toPNG());
    check(language+' settings screenshot captured after successful recovery',!captureWindow.isVisible(),captureWindow.getContentSize());
  }
  log.push(log.filter(s=>s.startsWith('PASS ')).length+'/'+log.filter(s=>/^(PASS|FAIL) /.test(s)).length+' checks passed');writeFileSync(join(__dirname,'window-ready-probe.log'),log.join('\n'));app.quit();app.exit(failed?1:0);
})().catch(e=>{log.push('ERROR '+e.stack);writeFileSync(join(__dirname,'window-ready-probe.log'),log.join('\n'));app.exit(1);});
