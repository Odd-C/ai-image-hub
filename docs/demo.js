const $ = selector => document.querySelector(selector);
const labels = {libtv:'LibTV',lovart:'Lovart',api:'API',queued:'排队中',running:'生成中',succeeded:'已完成'};
const sentimentLabels = {satisfied:'满意',adopted:'采用',dissatisfied:'不满意'};
const models = {
  libtv:['Lib Image','General image Pro','Seedream 5.0 Pro','Qwen image 3.0','Style Image V8.2'],
  lovart:['Nano Banana Pro','Nano Banana 2'],
  api:['Seedream 5.0 Pro','GPT Image 1']
};
const palettes = [
  'radial-gradient(circle at 68% 25%,#fff9e7 0 9%,transparent 27%),linear-gradient(145deg,#a77659,#efd1b0 52%,#f7eadc)',
  'radial-gradient(circle at 35% 42%,#f9ecd4 0 12%,transparent 28%),linear-gradient(160deg,#25352f,#759782 55%,#dbe3d8)',
  'radial-gradient(circle at 72% 38%,#fce7c3 0 8%,transparent 29%),linear-gradient(135deg,#6f2d2d,#c46e56 52%,#f4c19c)',
  'radial-gradient(circle at 36% 25%,#fff 0 8%,transparent 22%),linear-gradient(150deg,#a7b6c6,#e7edf0 50%,#8ca3b0)',
  'radial-gradient(circle at 62% 58%,#f1e5ff 0 12%,transparent 30%),linear-gradient(135deg,#30264c,#846eb0 50%,#e5d9f0)',
  'radial-gradient(circle at 40% 38%,#fff7d2 0 10%,transparent 28%),linear-gradient(145deg,#6a7351,#c4ce8f 52%,#f0eccd)'
];
let tasks = [
  {id:'a1',prompt:'现代极简风格的香水产品主视觉，透明玻璃瓶放置在浅灰色石材台面，柔和自然光，高级商业摄影质感',provider:'libtv',model:'Lib Image',status:'succeeded',sentiment:'adopted',art:0,time:'09:42'},
  {id:'a2',prompt:'春季护肤品海报，淡绿色植物、水面反射与透明亚克力底座，清爽自然，留出标题空间',provider:'lovart',model:'Nano Banana Pro',status:'succeeded',sentiment:'satisfied',art:1,time:'09:37'},
  {id:'a3',prompt:'复古红色咖啡包装静物，暖色电影光线，粗糙木质桌面，具有生活感的商业摄影',provider:'api',model:'Seedream 5.0 Pro',status:'running',sentiment:'',art:2,time:'09:31'},
  {id:'a4',prompt:'科技感银色耳机悬浮在冷蓝色空间，细微粒子与聚光灯，超现实产品广告',provider:'libtv',model:'General image Pro',status:'succeeded',sentiment:'dissatisfied',art:3,time:'昨天'},
  {id:'a5',prompt:'深紫色香氛礼盒，丝绒材质背景，精致边缘光，奢侈品视觉语言',provider:'lovart',model:'Nano Banana 2',status:'succeeded',sentiment:'satisfied',art:4,time:'昨天'},
  {id:'a6',prompt:'天然谷物早餐包装组合，阳光厨房场景，柔和米黄色调，健康有机品牌风格',provider:'api',model:'GPT Image 1',status:'succeeded',sentiment:'adopted',art:5,time:'周五'}
];
let selectedReferenceFiles=[];
let lightboxItems=[];
let lightboxIndex=0;
let lightboxScale=1;

function escapeHtml(value=''){const node=document.createElement('div');node.textContent=value;return node.innerHTML}
function toast(message){const node=$('#toast');node.textContent=message;node.className='toast show';setTimeout(()=>node.className='toast',2200)}
function switchView(name){document.querySelectorAll('.view').forEach(node=>node.classList.toggle('active',node.id===`${name}-view`));document.querySelectorAll('.nav-tab').forEach(node=>node.classList.toggle('active',node.dataset.view===name));location.hash=name}
function media(task){return task.status==='succeeded'?`<button type="button" class="result-image image-review-trigger" data-action="preview" data-id="${task.id}" aria-label="放大查看生成结果"><span class="generated-art" style="--art:${palettes[task.art%palettes.length]}"></span><span class="image-review-hint">点击放大</span></button>`:`<div class="result-placeholder ${task.status}"><span>◌</span><b>${labels[task.status]}</b></div>`}
function card(task,compact=false){const sentiments=!compact&&task.status==='succeeded'?`<div class="sentiment-row">${Object.entries(sentimentLabels).map(([key,value])=>`<button class="sentiment ${task.sentiment===key?'active':''}" data-action="sentiment" data-id="${task.id}" data-value="${key}">${value}</button>`).join('')}</div>`:'';return `<article class="result-card ${compact?'compact':''}">${media(task)}<div class="result-content"><div class="result-meta"><span>${labels[task.provider]} · ${escapeHtml(task.model)}</span><time>${task.time}</time></div><p title="${escapeHtml(task.prompt)}">${escapeHtml(task.prompt)}</p><div class="card-actions"><button class="secondary" data-action="reuse" data-id="${task.id}">再次使用</button>${task.status==='succeeded'?'<button class="secondary" data-action="download">下载</button>':''}</div>${sentiments}</div></article>`}
function render(){const q=$('#search-input').value.trim().toLowerCase();const provider=$('#filter-provider').value;const sentiment=$('#filter-sentiment').value;const filtered=tasks.filter(task=>(!q||task.prompt.toLowerCase().includes(q))&&(!provider||task.provider===provider)&&(!sentiment||task.sentiment===sentiment));$('#recent-list').innerHTML=tasks.slice(0,4).map(task=>card(task,true)).join('');$('#history-grid').innerHTML=filtered.length?filtered.map(task=>card(task)).join(''):'<div class="empty-state">没有符合条件的历史记录</div>';$('#history-count').textContent=filtered.length}
function renderResolutions(){const provider=$('#provider-select').value;const model=$('#model-select').value;const scalable=provider==='api'||['Lib Image','General image Pro','Qwen image 3.0'].includes(model);const values=scalable?['1K','2K','4K']:['2K'];$('#resolution-select').innerHTML=values.map(value=>`<option ${value==='2K'?'selected':''}>${value}</option>`).join('')}
function renderModels(){const provider=$('#provider-select').value;$('#model-select').innerHTML=models[provider].map(model=>`<option>${model}</option>`).join('');$('#availability-note').textContent=`${labels[provider]} · ${models[provider][0]}`;renderResolutions()}
function renderStatus(){const items=Object.entries(models).flatMap(([provider,list])=>list.slice(0,provider==='libtv'?5:2).map((model,index)=>({provider,model,on:!(provider==='api'&&index===1)})));$('#model-status-grid').innerHTML=items.map(item=>`<div><span class="status-dot ${item.on?'on':''}"></span><b>${item.model}</b><small>${labels[item.provider]} · ${item.on?'可用':'未配置'}</small></div>`).join('')}
function referenceKey(file){return `${file.name}:${file.size}:${file.lastModified}`}
function syncReferenceInput(){const transfer=new DataTransfer();selectedReferenceFiles.forEach(file=>transfer.items.add(file));$('#references').files=transfer.files;$('#reference-preview').innerHTML=selectedReferenceFiles.map((file,index)=>`<figure><img src="${URL.createObjectURL(file)}"><figcaption>${index+1}</figcaption><button type="button" class="remove-reference" data-remove-reference="${index}" aria-label="移除 ${escapeHtml(file.name)}">×</button></figure>`).join('')}
function addReferenceFiles(files){const known=new Set(selectedReferenceFiles.map(referenceKey));files.forEach(file=>{if(!known.has(referenceKey(file))){selectedReferenceFiles.push(file);known.add(referenceKey(file))}});if(selectedReferenceFiles.length>14){selectedReferenceFiles=selectedReferenceFiles.slice(0,14);toast('参考图最多 14 张')}syncReferenceInput()}
function updateLightbox(){const task=lightboxItems[lightboxIndex];if(!task)return;lightboxScale=1;$('#lightbox-art').style.setProperty('--art',palettes[task.art%palettes.length]);$('#lightbox-art').style.transform='scale(1)';$('#lightbox-title').textContent=task.model;$('#lightbox-counter').textContent=`${lightboxIndex+1} / ${lightboxItems.length}`;$('#lightbox-prompt').textContent=task.prompt;$('#lightbox-meta').textContent=`${labels[task.provider]} · 2K · 1:1`;$('#lightbox-zoom').textContent='100%'}
function openLightbox(id){lightboxItems=tasks.filter(task=>task.status==='succeeded');lightboxIndex=Math.max(0,lightboxItems.findIndex(task=>task.id===id));updateLightbox();$('#lightbox').showModal();document.body.classList.add('lightbox-open')}
function closeLightbox(){$('#lightbox').close();document.body.classList.remove('lightbox-open')}
function setLightboxScale(scale){lightboxScale=Math.min(4,Math.max(.5,scale));$('#lightbox-art').style.transform=`scale(${lightboxScale})`;$('#lightbox-zoom').textContent=`${Math.round(lightboxScale*100)}%`}
function handleLightboxAction(action){if(action==='close')closeLightbox();if(action==='download')toast('演示页不包含真实生成文件');if(action==='zoom-in')setLightboxScale(lightboxScale+.25);if(action==='zoom-out')setLightboxScale(lightboxScale-.25);if(action==='reset')setLightboxScale(1);if(action==='previous'||action==='next'){lightboxIndex=(lightboxIndex+(action==='previous'?-1:1)+lightboxItems.length)%lightboxItems.length;updateLightbox()}}

document.addEventListener('DOMContentLoaded',()=>{
  document.querySelectorAll('.nav-tab').forEach(button=>button.addEventListener('click',()=>switchView(button.dataset.view)));
  $('#prompt').addEventListener('input',event=>$('#prompt-count').textContent=event.target.value.length);
  $('#provider-select').addEventListener('change',renderModels);
  $('#model-select').addEventListener('change',()=>{$('#availability-note').textContent=`${labels[$('#provider-select').value]} · ${$('#model-select').value}`;renderResolutions()});
  $('#references').addEventListener('change',event=>addReferenceFiles([...event.target.files]));
  const dropzone=document.querySelector('.dropzone');dropzone.addEventListener('dragover',event=>{event.preventDefault();dropzone.classList.add('dragging')});dropzone.addEventListener('dragleave',()=>dropzone.classList.remove('dragging'));dropzone.addEventListener('drop',event=>{event.preventDefault();dropzone.classList.remove('dragging');addReferenceFiles([...event.dataTransfer.files])});
  $('#reference-preview').addEventListener('click',event=>{const button=event.target.closest('[data-remove-reference]');if(!button)return;selectedReferenceFiles.splice(Number(button.dataset.removeReference),1);syncReferenceInput()});
  $('#generation-form').addEventListener('submit',event=>{event.preventDefault();const button=event.submitter;button.textContent='正在提交…';button.disabled=true;const task={id:`a${Date.now()}`,prompt:$('#prompt').value,provider:$('#provider-select').value,model:$('#model-select').value,status:'running',sentiment:'',art:tasks.length,time:'刚刚'};tasks.unshift(task);render();setTimeout(()=>{task.status='succeeded';button.disabled=false;button.innerHTML='开始生成 <span>→</span>';render();toast('演示任务已生成完成')},1600);toast('演示任务已进入队列')});
  document.body.addEventListener('click',event=>{const target=event.target.closest('[data-action]');if(!target)return;const task=tasks.find(item=>item.id===target.dataset.id);if(target.dataset.action==='preview')openLightbox(task.id);else if(target.dataset.action==='sentiment'){task.sentiment=target.dataset.value;render();toast(`已标记为${sentimentLabels[target.dataset.value]}`)}else if(target.dataset.action==='reuse'){switchView('create');$('#prompt').value=task.prompt;$('#prompt-count').textContent=task.prompt.length;$('#provider-select').value=task.provider;renderModels();$('#model-select').value=task.model;toast('已载入历史提示词与参数')}else if(target.dataset.action==='download')toast('演示页不包含真实生成文件')});
  $('#lightbox').addEventListener('click',event=>{const button=event.target.closest('[data-lightbox-action]');if(button)handleLightboxAction(button.dataset.lightboxAction);else if(event.target===$('#lightbox'))closeLightbox()});
  document.querySelector('.lightbox-stage').addEventListener('wheel',event=>{event.preventDefault();setLightboxScale(lightboxScale+(event.deltaY<0?.15:-.15))},{passive:false});
  document.addEventListener('keydown',event=>{if(!$('#lightbox').open)return;if(event.key==='Escape')closeLightbox();if(event.key==='ArrowLeft')handleLightboxAction('previous');if(event.key==='ArrowRight')handleLightboxAction('next');if(event.key==='+'||event.key==='=')handleLightboxAction('zoom-in');if(event.key==='-')handleLightboxAction('zoom-out')});
  ['#search-input','#filter-provider','#filter-sentiment'].forEach(selector=>$(selector).addEventListener(selector==='#search-input'?'input':'change',render));
  $('#refresh-button').addEventListener('click',()=>{render();toast('任务状态已刷新')});
  $('#fake-create-user').addEventListener('click',()=>toast('这是静态演示，未创建真实账号'));
  renderModels();renderStatus();render();switchView(location.hash.slice(1)||'create');
});
