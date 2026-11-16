export const usagePage = String.raw`<!doctype html>
<html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ChatGPT 使用情况</title>
<style>
*{box-sizing:border-box}html,body{margin:0;background:transparent;color:#202020;font:13px/1.45 "Segoe UI",system-ui,sans-serif}button{font:inherit;color:inherit;cursor:pointer}#chip{position:fixed;left:8px;bottom:8px;width:78px;height:28px;display:flex;align-items:center;justify-content:center;gap:7px;padding:0 6px;white-space:nowrap;border:0;border-radius:7px;background:#ffffff80;font-size:12px}#chip:hover,#chip[aria-expanded=true]{background:#ffffffd9}#caret{font-size:10px;color:#727272}#panel{position:fixed;left:8px;bottom:48px;width:280px;max-height:350px;overflow:auto;border:1px solid #00000012;border-radius:12px;background:#fff;box-shadow:0 8px 28px #0000001c;padding:18px}#panel[hidden]{display:none}header{display:flex;align-items:center;justify-content:space-between;margin-bottom:17px}h2{margin:0;font-size:13px;font-weight:600}#refresh{border:0;background:transparent;padding:3px 0 3px 8px;color:#737373;font-size:12px}#refresh:hover{color:#181818}#refresh:disabled{opacity:.55;cursor:default}.window+.window{margin-top:19px}.line{display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin-bottom:8px}.name{font-weight:500}.value{font-size:12px;color:#646464}progress{display:block;width:100%;height:4px;border:0;border-radius:4px;overflow:hidden;background:#eee;appearance:none}progress::-webkit-progress-bar{background:#eee}progress::-webkit-progress-value{background:#242424;border-radius:4px}.reset{display:block;color:#858585;font-size:11px;margin-top:7px}#time{display:block;border-top:1px solid #eee;margin-top:16px;padding-top:12px;color:#909090;font-size:11px}.message{color:#737373;font-size:12px;margin:0;line-height:1.65}a{color:#343434;font-size:12px;display:inline-block;margin-top:10px;text-underline-offset:3px}.credits{font-size:12px;border-top:1px solid #eee;padding-top:13px;margin:17px 0 0;color:#737373}
</style>
<section id="panel" hidden><header><h2>使用情况</h2><button id="refresh" aria-label="刷新额度">刷新</button></header><div id="content" role="status"><p class="message">正在读取使用情况…</p></div><small id="time" hidden></small></section>
<button id="chip" aria-label="查看额度" aria-expanded="false"><span id="summary">额度</span><span id="caret" aria-hidden="true">⌃</span></button>
<script>
const chip=document.getElementById('chip'),panel=document.getElementById('panel'),content=document.getElementById('content'),refresh=document.getElementById('refresh'),summary=document.getElementById('summary'),time=document.getElementById('time');
const quotaSession='__QUOTA_SESSION__';
let busy=false;
function setSummary(text,label){summary.textContent=text;chip.setAttribute('aria-label',label);}
function resize(){if(window.parent!==window)window.parent.postMessage({type:'workbuddy-chatgpt-quota-size',open:!panel.hidden},'*');}
function close(){panel.hidden=true;chip.setAttribute('aria-expanded','false');resize();}
chip.onclick=()=>{panel.hidden=!panel.hidden;chip.setAttribute('aria-expanded',String(!panel.hidden));resize();if(!panel.hidden)load();};
document.addEventListener('keydown',event=>{if(event.key==='Escape')close();});
window.addEventListener('message',event=>{if(event.source===window.parent&&event.data?.type==='workbuddy-chatgpt-quota-close')close();});
function element(tag,text,className){const node=document.createElement(tag);node.textContent=text;if(className)node.className=className;return node;}
function label(window){const hours=window.windowSeconds/3600;const period=hours===5?'5 小时使用限额':hours===168?'每周使用限额':hours>0?hours+' 小时使用限额':'使用限额';return window.name.startsWith('Codex ')?period:window.name.replace(/ (primary|secondary)$/,'')+' · '+period;}
function resetTime(timestamp){const date=new Date(timestamp*1000);const today=new Date().toDateString()===date.toDateString();return '重置于 '+date.toLocaleString('zh-CN',today?{hour:'2-digit',minute:'2-digit'}:{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'});}
function unavailable(reason){setSummary('额度 —','额度 · —');content.replaceChildren(element('p',reason,'message'));time.hidden=true;}
async function load(force=false){
 if(busy)return;
 busy=true;refresh.disabled=true;refresh.textContent='刷新中';
 try{
  const response=await fetch('/bridge/usage'+(force?'?refresh=1':''),{credentials:'omit',headers:{'X-Quota-Session':quotaSession}});
  const data=await response.json();
  if(response.status===401){location.reload();return;}
  if(!response.ok){unavailable(data.error?.message||'暂时无法读取，请稍后刷新。');return;}
  if(!data.available){unavailable(data.reason||'当前账号尚未提供使用情况。');const link=element('a','登录 ChatGPT');link.href='/';link.target='_blank';link.rel='noopener';content.append(link);return;}
  content.replaceChildren();
  const windows=data.windows||[];
  if(windows.length){const remaining=Math.round(Math.min(...windows.map(item=>item.remainingPercent)));setSummary(remaining+'%','额度 · '+remaining+'%');}else setSummary('使用情况','查看额度');
  for(const item of windows){
   const row=element('div','','window'),line=element('div','','line');
   line.append(element('span',label(item),'name'),element('span','剩余 '+Math.round(item.remainingPercent)+'%','value'));
   const bar=document.createElement('progress');bar.max=100;bar.value=item.remainingPercent;bar.setAttribute('aria-label',label(item)+'剩余额度');row.append(line,bar);
   if(item.resetAt)row.append(element('small',resetTime(item.resetAt),'reset'));
   content.append(row);
  }
  if(data.credits)content.append(element('p',data.credits.unlimited?'积分不限量':data.credits.balance!==undefined?'积分余额 '+data.credits.balance:'积分余额未提供','credits'));
  time.hidden=false;time.textContent='更新于 '+new Date(data.fetchedAt).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'});
 }catch{unavailable('无法连接本地服务，请确认连接器正在运行后刷新。');}
 finally{busy=false;refresh.disabled=false;refresh.textContent='刷新';}
}
refresh.onclick=()=>load(true);load();setInterval(load,60000);
</script></html>`;
