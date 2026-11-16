export const usagePage = String.raw`<!doctype html>
<html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ChatGPT 使用情况</title>
<style>
*{box-sizing:border-box}html,body{margin:0;background:transparent;color:#202020;font:13px/1.45 "Segoe UI",system-ui,sans-serif}button{font:inherit;color:inherit;cursor:pointer}#chip{position:fixed;left:8px;bottom:8px;width:32px;height:32px;display:flex;align-items:center;justify-content:center;gap:0;padding:2px;white-space:nowrap;border:0;border-radius:7px;background:transparent;font-size:12px}#chip:hover,#chip[aria-expanded=true]{background:#ffffffd9}#summary{display:none}#meter{width:24px;height:24px;color:#707771}#meter .track{stroke:#b9c0bb;opacity:.5}#meter .fill{transition:stroke-dashoffset .25s ease}#meter .low{stroke:#c27530}@media(prefers-reduced-motion:reduce){#meter .fill{transition:none}}#source{margin:0;color:#8a8a8a;font-size:12px}header{padding-bottom:12px;border-bottom:1px solid #ededed}.window+.window{margin-top:12px}.line{margin-bottom:0}.name{font-weight:400}.reset{margin-top:3px}progress{display:none}#panel{position:fixed;left:8px;bottom:48px;width:280px;max-height:350px;overflow:auto;border:1px solid #00000012;border-radius:12px;background:#fff;box-shadow:0 8px 28px #0000001c;padding:18px}#panel[hidden]{display:none}header{display:flex;align-items:center;justify-content:space-between;margin-bottom:17px}h2{margin:0;font-size:13px;font-weight:600}#refresh{border:0;background:transparent;padding:3px 0 3px 8px;color:#737373;font-size:12px}#refresh:hover{color:#181818}#refresh:disabled{opacity:.55;cursor:default}.window+.window{margin-top:19px}.line{display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin-bottom:8px}.name{font-weight:500}.value{font-size:12px;color:#646464}progress{display:none;width:100%;height:4px;border:0;border-radius:4px;overflow:hidden;background:#eee;appearance:none}progress::-webkit-progress-bar{background:#eee}progress::-webkit-progress-value{background:#242424;border-radius:4px}.reset{display:block;color:#858585;font-size:11px;margin-top:7px}#time{display:block;border-top:1px solid #eee;margin-top:16px;padding-top:12px;color:#909090;font-size:11px}.message{color:#737373;font-size:12px;margin:0;line-height:1.65}a{color:#343434;font-size:12px;display:inline-block;margin-top:10px;text-underline-offset:3px}.credits{font-size:12px;border-top:1px solid #eee;padding-top:13px;margin:17px 0 0;color:#737373}
</style>
<section id="panel" hidden><header><p id="source">使用情况</p><button id="refresh" aria-label="刷新额度">刷新</button></header><div id="content" role="status"><p class="message">正在读取使用情况…</p></div><small id="time" hidden></small></section>
<button id="chip" aria-label="查看额度" aria-expanded="false"><span id="summary">额度</span><svg id="meter" viewBox="2.5 2.5 27 27" fill="none" stroke-width="2" aria-hidden="true"><g id="segments"></g><path d="M15 12.5 Q16 11.5 17 12.5 L19.5 15 Q20.5 16 19.5 17 L17 19.5 Q16 20.5 15 19.5 L12.5 17 Q11.5 16 12.5 15 Z" fill="currentColor" stroke="none"/></svg></button>
<script>
const chip=document.getElementById('chip'),panel=document.getElementById('panel'),content=document.getElementById('content'),refresh=document.getElementById('refresh'),summary=document.getElementById('summary'),time=document.getElementById('time');
const quotaSession='__QUOTA_SESSION__';
let busy=false;
function setSummary(text,label){summary.textContent=text;chip.setAttribute('aria-label',label);chip.title=label;}
function drawMeter(windows=[]){
 const primary=windows.find(item=>item.name==='Codex primary');
 const secondary=windows.find(item=>item.name==='Codex secondary');
 const buckets=[primary,secondary].filter(Boolean);
 const paths=buckets.length>1?['M6.4244 7.9652 A12.5 12.5 0 0 1 25.5756 7.9652','M3.6899 13.8294 A12.5 12.5 0 1 0 28.3101 13.8294']:['M16 3.5 A12.5 12.5 0 1 1 16 28.5 A12.5 12.5 0 1 1 16 3.5'];
 const group=document.getElementById('segments');group.replaceChildren();
 for(let index=0;index<Math.max(1,buckets.length);index++){
  const bucket=buckets[index];
  for(const track of [true,false]){
   const path=document.createElementNS('http://www.w3.org/2000/svg','path');
   path.setAttribute('d',paths[index]);path.setAttribute('stroke-linecap','round');
   path.setAttribute('class',track?'track':'fill'+(bucket?.remainingPercent<15?' low':''));
   path.setAttribute('stroke','currentColor');
   if(!track){path.setAttribute('pathLength','100');path.setAttribute('stroke-dasharray','100');path.setAttribute('stroke-dashoffset',String(100-(bucket?.remainingPercent??0)));}
   group.append(path);
  }
 }
 if(buckets.length)chip.title=buckets.map(item=>label(item)+' · 剩余 '+Math.round(item.remainingPercent)+'%').join('\n');
}

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
  const planNames={plus:'Plus',pro:'Pro',free:'Free',team:'Business',business:'Business'};
  document.getElementById('source').textContent=data.planType?'额度来源：你的 '+(planNames[data.planType]||data.planType)+' 套餐':'使用情况';
  if(windows.length){const remaining=Math.round(Math.min(...windows.map(item=>item.remainingPercent)));setSummary(remaining+'%','额度 · '+remaining+'%');}else setSummary('使用情况','查看额度');
  drawMeter(windows);
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
refresh.onclick=()=>load(true);drawMeter();load();setInterval(load,60000);
</script></html>`;
