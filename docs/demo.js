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
  {id:'a1',prompt:'现代极简风格的香水产品主视觉，透明玻璃瓶放置在浅灰色石材台面，柔和自然光，高级商业摄影质感',provider:'libtv',model:'Lib Image',status:'succeeded',sentiment:'adopted',art:0,time:'09:42',ratio:'1:1',resolution:'2K',referenceOrder:['ref-1','ref-2']},
  {id:'a2',prompt:'春季护肤品海报，淡绿色植物、水面反射与透明亚克力底座，清爽自然，留出标题空间',provider:'lovart',model:'Nano Banana Pro',status:'succeeded',sentiment:'satisfied',art:1,time:'09:37',ratio:'3:4',resolution:'2K',referenceOrder:['result-a1']},
  {id:'a3',prompt:'复古红色咖啡包装静物，暖色电影光线，粗糙木质桌面，具有生活感的商业摄影',provider:'api',model:'Seedream 5.0 Pro',status:'running',sentiment:'',art:2,time:'09:31',ratio:'4:3',resolution:'2K',referenceOrder:['ref-1']},
  {id:'a4',prompt:'科技感银色耳机悬浮在冷蓝色空间，细微粒子与聚光灯，超现实产品广告',provider:'libtv',model:'General image Pro',status:'succeeded',sentiment:'dissatisfied',art:3,time:'昨天',ratio:'16:9',resolution:'4K',referenceOrder:[]},
  {id:'a5',prompt:'深紫色香氛礼盒，丝绒材质背景，精致边缘光，奢侈品视觉语言',provider:'lovart',model:'Nano Banana 2',status:'succeeded',sentiment:'satisfied',art:4,time:'昨天',ratio:'1:1',resolution:'2K',referenceOrder:[]},
  {id:'a6',prompt:'天然谷物早餐包装组合，阳光厨房场景，柔和米黄色调，健康有机品牌风格',provider:'api',model:'GPT Image 1',status:'succeeded',sentiment:'adopted',art:5,time:'周五',ratio:'4:3',resolution:'2K',referenceOrder:[]}
];

let nodes = [
  {id:'ref-1',type:'reference',title:'产品正面参考',x:500,y:460,w:250,ratio:1,art:5},
  {id:'ref-2',type:'reference',title:'材质与瓶盖参考',x:500,y:795,w:250,ratio:4/3,art:3},
  {id:'result-a1',type:'result',title:'Lib Image · 主视觉',x:880,y:430,w:310,ratio:1,taskId:'a1',art:0,parents:['ref-1','ref-2']},
  {id:'result-a2',type:'result',title:'Nano Banana Pro · 春季版',x:1260,y:440,w:310,ratio:3/4,taskId:'a2',art:1,parents:['result-a1']},
  {id:'result-a3',type:'result',title:'Seedream 5.0 Pro',x:880,y:805,w:310,ratio:4/3,taskId:'a3',art:2,parents:['ref-1']},
  {id:'note-1',type:'note',title:'创作备注',text:'保留瓶身比例和透明材质，背景可以继续尝试更冷的灰色。',x:1260,y:840,w:250}
];

let projects = [
  {id:'p1',name:'香氛视觉探索',updated:'刚刚',art:0},
  {id:'p2',name:'咖啡包装升级',updated:'昨天',art:2},
  {id:'p3',name:'耳机秋季 Campaign',updated:'周五',art:3}
];
let activeProjectId = 'p1';
let demoRole = 'user';
const clone = value => JSON.parse(JSON.stringify(value));
const projectStates = {
  p1:{nodes:clone(nodes),tasks:clone(tasks),view:{x:-350,y:-310,scale:.82},references:['ref-1','ref-2']},
  p2:{
    nodes:[
      {id:'coffee-ref',type:'reference',title:'旧版包装参考',x:560,y:520,w:260,ratio:1,art:2},
      {id:'coffee-result',type:'result',title:'Seedream · 包装升级',x:980,y:510,w:320,ratio:1,taskId:'coffee-task',art:5,parents:['coffee-ref']}
    ],
    tasks:[{id:'coffee-task',prompt:'复古咖啡包装升级，保留红色品牌识别，增加现代烘焙质感和货架冲击力',provider:'api',model:'Seedream 5.0 Pro',status:'succeeded',sentiment:'satisfied',art:5,time:'昨天',ratio:'1:1',resolution:'2K',referenceOrder:['coffee-ref']}],
    view:{x:-420,y:-330,scale:.78},references:['coffee-ref']
  },
  p3:{nodes:[],tasks:[],view:{x:120,y:80,scale:1},references:[]}
};

let selectedIds = new Set();
let referenceOrder = ['ref-1','ref-2'];
let referencePickMode = false;
let inspectedNodeId = null;
let draftSnapshot = null;
let ignoreClickUntil = 0;
let view = {x:-350,y:-310,scale:.82};
let interaction = null;
let minimapState = null;
let lastNodePress = null;
let lightboxItems=[];
let lightboxIndex=0;
let lightboxScale=1;
let lightboxPanX=0;
let lightboxPanY=0;
let lightboxDrag=null;

function escapeHtml(value=''){const node=document.createElement('div');node.textContent=value;return node.innerHTML}
function toast(message){const node=$('#toast');node.textContent=message;node.className='toast show';setTimeout(()=>node.className='toast',2200)}
function taskForNode(node){return tasks.find(task=>task.id===node.taskId)}
function nodeHeight(node){if(node.type==='note')return 110;return node.w/(node.ratio||1)+(node.type==='result'?78:55)}
function worldPoint(clientX,clientY){const rect=$('#canvas-viewport').getBoundingClientRect();return {x:(clientX-rect.left-view.x)/view.scale,y:(clientY-rect.top-view.y)/view.scale}}

function formSnapshot(){return {prompt:$('#prompt').value,provider:$('#provider-select').value,model:$('#model-select').value,ratio:$('#ratio-select').value,resolution:$('#resolution-select').value,batch:$('#batch-count').value,references:[...referenceOrder]}}
function applyFormSnapshot(state){if(!state)return;$('#prompt').value=state.prompt;$('#prompt-count').textContent=state.prompt.length;$('#provider-select').value=state.provider;renderModels(state.model);$('#model-select').value=state.model;renderResolutions();if([...$('#ratio-select').options].some(option=>option.value===state.ratio))$('#ratio-select').value=state.ratio;if([...$('#resolution-select').options].some(option=>option.value===state.resolution))$('#resolution-select').value=state.resolution;$('#batch-count').value=state.batch||'1';referenceOrder=[...state.references]}
function setDockMode(inspecting){document.querySelector('.generation-dock').classList.toggle('inspecting',inspecting);$('#inspection-banner').classList.toggle('visible',inspecting);$('#dock-mode-label').textContent=inspecting?'REUSE RESULT':'GENERATE';$('#dock-title').textContent=inspecting?'修改并再次生成':'图像生成';$('#dock-description').textContent=inspecting?'已临时载入该结果的生成信息；修改后可直接生成新图。':'选择参考素材，再生成新版本。';$('#prompt-title').textContent=inspecting?'该结果的原始提示词':'提示词'}
function inspectResult(node){const task=taskForNode(node);if(!task||task.status!=='succeeded')return;if(!inspectedNodeId)draftSnapshot=formSnapshot();inspectedNodeId=node.id;selectedIds=new Set([node.id]);applyFormSnapshot({prompt:task.prompt,provider:task.provider,model:task.model,ratio:task.ratio||'1:1',resolution:task.resolution||'2K',batch:'1',references:task.referenceOrder?.filter(id=>nodes.some(node=>node.id===id))||node.parents||[]});setDockMode(true);renderCanvas()}
function exitInspection(){if(!inspectedNodeId)return;inspectedNodeId=null;selectedIds.clear();applyFormSnapshot(draftSnapshot);draftSnapshot=null;setDockMode(false);renderCanvas()}
function toggleReference(id){const node=nodes.find(item=>item.id===id);if(!node||node.type==='note'||taskForNode(node)?.status==='running')return;if(referenceOrder.includes(id))referenceOrder=referenceOrder.filter(item=>item!==id);else referenceOrder.push(id);renderCanvas()}

function saveActiveProject(){
  if(!activeProjectId)return;
  projectStates[activeProjectId]={nodes:clone(nodes),tasks:clone(tasks),view:{...view},references:[...referenceOrder]};
  const project=projects.find(item=>item.id===activeProjectId);if(project)project.updated='刚刚';
}

function renderProjects(){
  $('#project-count').textContent=projects.length;
  $('#project-grid').innerHTML=projects.map(project=>{
    const state=projectStates[project.id],count=state?.tasks.length||0,cover=count?`<span class="node-art" style="--art:${palettes[project.art%palettes.length]}"></span>`:'<span>IH</span>';
    return `<article class="demo-project-card" data-project-id="${project.id}"><button class="demo-project-cover ${count?'':'empty'}" data-project-action="open">${cover}</button><div class="demo-project-body"><div><h2>${escapeHtml(project.name)}</h2><p>${count} 次生成 · ${project.updated}</p></div><div class="demo-project-actions"><button data-project-action="rename">重命名</button><button data-project-action="archive">归档</button></div></div></article>`
  }).join('')||'<div class="empty-state">还没有项目，先创建一个。</div>';
}

function openProject(projectId){
  saveActiveProject();activeProjectId=projectId;
  const state=projectStates[projectId]||{nodes:[],tasks:[],view:{x:100,y:80,scale:1},references:[]};
  nodes=clone(state.nodes);tasks=clone(state.tasks);view={...state.view};referenceOrder=[...state.references];selectedIds.clear();inspectedNodeId=null;draftSnapshot=null;setDockMode(false);
  const project=projects.find(item=>item.id===projectId);$('#canvas-project-name').textContent=project?.name||'未命名项目';
  $('#queue-count').textContent=tasks.filter(task=>task.status==='running').length;renderHistory();switchView('create');renderCanvas();if(nodes.length)requestAnimationFrame(fitView);
}

function setDemoRole(role){
  demoRole=role==='admin'?'admin':'user';const isAdmin=demoRole==='admin';
  document.querySelector('.admin-only').hidden=!isAdmin;$('#demo-account-label').textContent=`演示部门 · ${isAdmin?'管理员':'普通用户'}`;$('#account-menu-button').textContent=isAdmin?'管':'普';$('#account-menu').classList.remove('open');
  if(!isAdmin&&location.hash==='#admin')switchView('projects');
  toast(isAdmin?'已切换为管理员预览，可见系统管理':'已切换为普通用户，不显示管理入口');
}

function switchView(name){
  if(name==='admin'&&demoRole!=='admin')name='projects';
  document.querySelectorAll('.view').forEach(node=>node.classList.toggle('active',node.id===`${name}-view`));
  document.querySelectorAll('.nav-tab').forEach(node=>node.classList.toggle('active',node.dataset.view===name));
  document.body.classList.toggle('canvas-active',name==='create');
  document.body.classList.toggle('in-project',name==='create'||name==='history');
  location.hash=name;
  if(name==='projects')renderProjects();
  if(name==='create')requestAnimationFrame(renderCanvas);
}

function nodeMedia(node){
  if(node.status==='running'||taskForNode(node)?.status==='running')return '<div class="node-loading"><i></i><b>正在生成</b><small>任务将在完成后自动更新</small></div>';
  if(node.src)return `<img src="${node.src}" alt="${escapeHtml(node.title)}" draggable="false">`;
  return `<span class="node-art" style="--art:${palettes[node.art%palettes.length]}"></span>`;
}

function renderNode(node){
  if(node.type==='note')return `<article class="canvas-node note ${selectedIds.has(node.id)?'selected':''}" data-node-id="${node.id}" style="left:${node.x}px;top:${node.y}px;width:${node.w}px"><div class="node-actions"><button data-node-action="duplicate" title="复制">⧉</button><button data-node-action="delete" title="删除">×</button></div><span class="node-badge">NOTE</span><p contenteditable="true">${escapeHtml(node.text)}</p><span class="resize-handle"></span></article>`;
  const task=taskForNode(node);
  const status=task?.status||node.status||'succeeded';
  const order=referenceOrder.indexOf(node.id);
  return `<article class="canvas-node ${node.type} ${selectedIds.has(node.id)?'selected':''} ${inspectedNodeId===node.id?'inspected':''}" data-node-id="${node.id}" style="left:${node.x}px;top:${node.y}px;width:${node.w}px;--ratio:${node.ratio||1}"><div class="node-actions"><button data-node-action="duplicate" title="复制">⧉</button><button data-node-action="delete" title="删除">×</button></div><span class="node-badge">${node.type==='reference'?'参考图':status==='running'?'生成中':'生成结果'}</span>${order>=0?`<span class="selection-order">图${order+1}</span>`:''}<div class="node-media" data-node-preview="${node.id}">${nodeMedia(node)}</div><footer class="node-footer"><div><b>${escapeHtml(node.title)}</b><time>${task?.time||'刚刚'}</time></div><p>${escapeHtml(task?.prompt||'画布参考素材')}</p></footer><span class="resize-handle"></span></article>`;
}

function renderLinks(){
  const paths=['<defs><marker id="arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 Z" class="arrow-head"/></marker></defs>'];
  for(const node of nodes){
    for(const parentId of node.parents||[]){
      const parent=nodes.find(item=>item.id===parentId);if(!parent)continue;
      const x1=parent.x+parent.w,y1=parent.y+nodeHeight(parent)/2,x2=node.x,y2=node.y+nodeHeight(node)/2;
      const bend=Math.max(70,Math.abs(x2-x1)*.46);
      paths.push(`<path d="M ${x1} ${y1} C ${x1+bend} ${y1}, ${x2-bend} ${y2}, ${x2} ${y2}" marker-end="url(#arrow)"/>`);
    }
  }
  $('#canvas-links').innerHTML=paths.join('');
}

function applyViewport(){
  $('#canvas-world').style.transform=`translate3d(${view.x}px,${view.y}px,0) scale(${view.scale})`;
  $('#canvas-zoom').textContent=`${Math.round(view.scale*100)}%`;
  const grid=24*view.scale;
  $('#canvas-viewport').style.backgroundSize=`${grid}px ${grid}px`;
  $('#canvas-viewport').style.backgroundPosition=`${view.x%grid}px ${view.y%grid}px`;
  updateMinimap();
}

function updateMinimap(){
  const minimap=$('#minimap'),viewport=$('#canvas-viewport');
  if(!minimap||!viewport||!nodes.length)return;
  const visible={x:-view.x/view.scale,y:-view.y/view.scale,w:viewport.clientWidth/view.scale,h:viewport.clientHeight/view.scale};
  const margin=160,minX=Math.min(visible.x,...nodes.map(n=>n.x))-margin,minY=Math.min(visible.y,...nodes.map(n=>n.y))-margin;
  const maxX=Math.max(visible.x+visible.w,...nodes.map(n=>n.x+n.w))+margin,maxY=Math.max(visible.y+visible.h,...nodes.map(n=>n.y+nodeHeight(n)))+margin;
  const pad=5,scale=Math.min((minimap.clientWidth-pad*2)/(maxX-minX),(minimap.clientHeight-pad*2)/(maxY-minY));
  minimapState={minX,minY,scale,pad};
  const blocks=nodes.map(node=>`<span class="minimap-node ${node.type}" style="left:${pad+(node.x-minX)*scale}px;top:${pad+(node.y-minY)*scale}px;width:${Math.max(3,node.w*scale)}px;height:${Math.max(3,nodeHeight(node)*scale)}px"></span>`).join('');
  const box=`<span class="minimap-viewport" style="left:${pad+(visible.x-minX)*scale}px;top:${pad+(visible.y-minY)*scale}px;width:${visible.w*scale}px;height:${visible.h*scale}px"></span>`;
  minimap.innerHTML=blocks+box;
}

function panFromMinimap(clientX,clientY){
  if(!minimapState)return;const minimap=$('#minimap').getBoundingClientRect(),viewport=$('#canvas-viewport');
  const worldX=minimapState.minX+(clientX-minimap.left-minimapState.pad)/minimapState.scale;
  const worldY=minimapState.minY+(clientY-minimap.top-minimapState.pad)/minimapState.scale;
  view.x=viewport.clientWidth/2-worldX*view.scale;view.y=viewport.clientHeight/2-worldY*view.scale;applyViewport();
}

function renderSelectedAssets(){
  const selected=referenceOrder.map(id=>nodes.find(node=>node.id===id)).filter(node=>node&&node.type!=='note'&&taskForNode(node)?.status!=='running');
  $('#selected-count').textContent=`${selected.length} 张已选`;
  $('#selection-status').textContent=referencePickMode?'参考图选择模式：Shift＋左键添加':'拖动空白处移动画布';
  $('#reference-picker-button').classList.toggle('active',referencePickMode);
  $('#reference-picker-button').textContent=referencePickMode?'完成选择':'＋ 选择参考图';
  $('#canvas-viewport').classList.toggle('reference-picking',referencePickMode);
  $('#selected-assets-list').innerHTML=selected.length?selected.map((node,index)=>`<span class="selected-chip" draggable="true" data-reference-id="${node.id}" title="拖拽调整顺序"><span class="chip-grip">⋮⋮</span>${node.src?`<img src="${node.src}">`:`<i class="chip-art" style="--art:${palettes[node.art%palettes.length]}"></i>`}<b>图${index+1}</b><button type="button" data-remove-reference="${node.id}" aria-label="删除图${index+1}">×</button></span>`).join(''):'<p>点击“选择参考图”，再用 Shift＋左键选择</p>';
}

function renderCanvas(){
  $('#canvas-nodes').innerHTML=nodes.map(renderNode).join('');
  $('.canvas-empty-hint').style.display=nodes.length?'none':'block';
  renderLinks();renderSelectedAssets();applyViewport();
}

function selectNode(id,additive=false){
  if(!additive)selectedIds.clear();
  if(additive&&selectedIds.has(id))selectedIds.delete(id);else selectedIds.add(id);
  renderCanvas();
}

function zoomCanvas(nextScale,clientX,clientY){
  const viewport=$('#canvas-viewport');const rect=viewport.getBoundingClientRect();const sx=(clientX??rect.left+rect.width/2)-rect.left;const sy=(clientY??rect.top+rect.height/2)-rect.top;const wx=(sx-view.x)/view.scale;const wy=(sy-view.y)/view.scale;view.scale=Math.min(2.5,Math.max(.25,nextScale));view.x=sx-wx*view.scale;view.y=sy-wy*view.scale;applyViewport();
}

function fitView(){
  if(!nodes.length)return;const viewport=$('#canvas-viewport').getBoundingClientRect();const minX=Math.min(...nodes.map(n=>n.x)),minY=Math.min(...nodes.map(n=>n.y));const maxX=Math.max(...nodes.map(n=>n.x+n.w)),maxY=Math.max(...nodes.map(n=>n.y+nodeHeight(n)));const scale=Math.min(1.1,(viewport.width-130)/(maxX-minX),(viewport.height-120)/(maxY-minY));view.scale=Math.max(.25,scale);view.x=(viewport.width-(maxX-minX)*view.scale)/2-minX*view.scale;view.y=(viewport.height-(maxY-minY)*view.scale)/2-minY*view.scale;applyViewport();
}

function addUploadedFiles(files,point){
  [...files].filter(file=>file.type.startsWith('image/')).forEach((file,index)=>{const src=URL.createObjectURL(file);const image=new Image();image.onload=()=>{const ratio=image.naturalWidth/image.naturalHeight;nodes.push({id:`upload-${Date.now()}-${index}`,type:'reference',title:file.name,x:point.x+index*35,y:point.y+index*35,w:Math.min(320,Math.max(190,240*ratio)),ratio,src});renderCanvas()};image.src=src});toast(`${files.length} 张素材已放入画布`);
}

function addNote(text='双击这里输入创作备注…',point=null){const rect=$('#canvas-viewport').getBoundingClientRect();const p=point||worldPoint(rect.left+rect.width/2,rect.top+rect.height/2);nodes.push({id:`note-${Date.now()}`,type:'note',title:'备注',text,x:p.x-125,y:p.y-55,w:250});renderCanvas();toast('提示词已放到画布作为备注')}

function renderHistory(){
  const q=$('#search-input').value.trim().toLowerCase(),provider=$('#filter-provider').value,sentiment=$('#filter-sentiment').value;
  const filtered=tasks.filter(task=>(!q||task.prompt.toLowerCase().includes(q))&&(!provider||task.provider===provider)&&(!sentiment||task.sentiment===sentiment));
  $('#history-count').textContent=filtered.length;
  $('#history-grid').innerHTML=filtered.map(task=>{const sentiments=task.status==='succeeded'?`<div class="sentiment-row">${Object.entries(sentimentLabels).map(([key,value])=>`<button class="sentiment ${task.sentiment===key?'active':''}" data-action="sentiment" data-id="${task.id}" data-value="${key}">${value}</button>`).join('')}</div>`:'';const media=task.status==='running'?'<div class="result-image"><span class="node-loading"><i></i><b>生成中</b></span></div>':`<button class="result-image" data-action="preview-task" data-id="${task.id}"><span class="node-art" style="--art:${palettes[task.art%palettes.length]}"></span></button>`;return `<article class="result-card">${media}<div class="result-content"><div class="result-meta"><span>${labels[task.provider]} · ${escapeHtml(task.model)}</span><time>${task.time}</time></div><p>${escapeHtml(task.prompt)}</p><div class="card-actions"><button class="secondary" data-action="locate" data-id="${task.id}">回到画布</button><button class="secondary" data-action="reuse" data-id="${task.id}">再次使用</button></div>${sentiments}</div></article>`}).join('')||'<div class="empty-state">没有符合条件的历史记录</div>';
}

function renderModels(){const provider=$('#provider-select').value;$('#model-select').innerHTML=models[provider].map(model=>`<option>${model}</option>`).join('');renderResolutions()}
function renderResolutions(){const provider=$('#provider-select').value,model=$('#model-select').value;const scalable=provider==='api'||['Lib Image','General image Pro','Qwen image 3.0'].includes(model);$('#resolution-select').innerHTML=(scalable?['1K','2K','4K']:['2K']).map(value=>`<option ${value==='2K'?'selected':''}>${value}</option>`).join('')}
function renderStatus(){const items=Object.entries(models).flatMap(([provider,list])=>list.slice(0,provider==='libtv'?5:2).map((model,index)=>({provider,model,on:!(provider==='api'&&index===1)})));$('#model-status-grid').innerHTML=items.map(item=>`<div><span class="status-dot ${item.on?'on':''}"></span><b>${item.model}</b><small>${labels[item.provider]} · ${item.on?'可用':'未配置'}</small></div>`).join('')}

function createGeneration(){
  const prompt=$('#prompt').value.trim();if(!prompt)return;
  if(inspectedNodeId){inspectedNodeId=null;draftSnapshot=null;setDockMode(false)}
  referencePickMode=false;
  const refs=referenceOrder.map(id=>nodes.find(node=>node.id===id)).filter(node=>node&&node.type!=='note');
  const anchor=refs.length?Math.max(...refs.map(node=>node.x+node.w)):worldPoint(innerWidth/2,innerHeight/2).x;
  const top=refs.length?Math.min(...refs.map(node=>node.y)):700;
  const batch=Math.min(4,Math.max(1,Number($('#batch-count').value)||1));
  const ratioText=$('#ratio-select').value;
  const ratios={'1:1':1,'4:3':4/3,'3:4':3/4,'16:9':16/9,'9:16':9/16};
  const resultRatio=ratios[ratioText]||1;
  const base=Date.now(),created=[];
  for(let index=0;index<batch;index++){
    const id=`a${base}-${index}`,nodeId=`result-${id}`;
    const task={id,prompt,provider:$('#provider-select').value,model:$('#model-select').value,status:'running',sentiment:'',art:tasks.length+index,time:'刚刚',ratio:ratioText,resolution:$('#resolution-select').value,batchIndex:index+1,batchSize:batch,referenceOrder:refs.map(node=>node.id)};
    tasks.unshift(task);
    nodes.push({id:nodeId,type:'result',title:`${task.model} · ${batch>1?`${index+1}/${batch}`:'新结果'}`,x:anchor+180+(index%2)*350,y:top+Math.floor(index/2)*390,w:310,ratio:resultRatio,taskId:id,art:task.art,parents:refs.map(node=>node.id)});
    created.push({task,nodeId});
  }
  selectedIds=new Set(created.map(item=>item.nodeId));
  $('#queue-count').textContent=tasks.filter(task=>task.status==='running').length;renderCanvas();renderHistory();toast(`${batch} 个任务已进入队列，并按图1、图2顺序使用参考素材`);
  created.forEach(({task},index)=>setTimeout(()=>{task.status='succeeded';$('#queue-count').textContent=tasks.filter(item=>item.status==='running').length;renderCanvas();renderHistory();if(index===created.length-1)toast(`${batch} 张图片已全部生成，可双击进入审图`)},1500+index*350));
}

function locateTask(taskId){const node=nodes.find(item=>item.taskId===taskId);if(!node)return toast('该历史记录尚未放入当前画布');switchView('create');inspectResult(node);const rect=$('#canvas-viewport').getBoundingClientRect();view.x=rect.width/2-(node.x+node.w/2)*view.scale;view.y=rect.height/2-(node.y+nodeHeight(node)/2)*view.scale;renderCanvas()}

function lightboxSource(task){return palettes[task.art%palettes.length]}
function ratioNumber(value){if(typeof value==='number')return value;const [width,height]=String(value||'1:1').split(':').map(Number);return width&&height?width/height:1}
function sizeLightboxArt(){const art=$('#lightbox-art'),canvas=document.querySelector('.lightbox-canvas'),ratio=Number(art.dataset.ratio)||1;const availableWidth=Math.max(100,canvas.clientWidth-36),availableHeight=Math.max(100,canvas.clientHeight-36);let width=availableWidth,height=width/ratio;if(height>availableHeight){height=availableHeight;width=height*ratio}art.style.width=`${width}px`;art.style.height=`${height}px`;art.style.marginLeft=`${-width/2}px`;art.style.marginTop=`${-height/2}px`}
function applyLightboxTransform(){$('#lightbox-art').style.transform=`translate3d(${lightboxPanX}px,${lightboxPanY}px,0) scale(${lightboxScale})`;$('#lightbox-zoom').textContent=`${Math.round(lightboxScale*100)}%`}
function updateLightbox(){const task=lightboxItems[lightboxIndex];if(!task)return;lightboxScale=1;lightboxPanX=0;lightboxPanY=0;const art=$('#lightbox-art'),ratio=ratioNumber(task.ratio);art.dataset.ratio=ratio;art.style.setProperty('--art',task.src?`url("${task.src}")`:lightboxSource(task));art.className=`lightbox-art ${task.src?'':'generated'}`;applyLightboxTransform();$('#lightbox-title').textContent=task.model||task.title;$('#lightbox-counter').textContent=`${lightboxIndex+1} / ${lightboxItems.length}`;$('#lightbox-prompt').textContent=task.prompt||'画布参考素材';$('#lightbox-meta').textContent=task.meta||`${labels[task.provider]||task.provider} · ${task.resolution||'2K'} · ${task.displayRatio||task.ratio||'1:1'}`;requestAnimationFrame(sizeLightboxArt)}
function showLightbox(){if(!$('#lightbox').open)$('#lightbox').showModal();document.body.classList.add('lightbox-open');requestAnimationFrame(sizeLightboxArt)}
function openLightbox(taskId){lightboxItems=tasks.filter(task=>task.status==='succeeded');lightboxIndex=Math.max(0,lightboxItems.findIndex(task=>task.id===taskId));updateLightbox();showLightbox()}
function openNodeLightbox(nodeId){const imageNodes=nodes.filter(node=>node.type!=='note'&&taskForNode(node)?.status!=='running');lightboxItems=imageNodes.map(node=>{const task=taskForNode(node);return task?{...task,displayRatio:task.ratio,ratio:node.ratio,src:node.src}:{id:node.id,title:node.title,prompt:'画布参考素材',provider:'参考图',meta:`参考素材 · 原始比例 ${node.ratio.toFixed(2)}:1`,ratio:node.ratio,art:node.art,src:node.src}});lightboxIndex=Math.max(0,imageNodes.findIndex(node=>node.id===nodeId));updateLightbox();showLightbox()}
function closeLightbox(){$('#lightbox').close();document.body.classList.remove('lightbox-open')}
function setLightboxScale(scale){lightboxScale=Math.min(4,Math.max(.5,scale));if(lightboxScale<=1){lightboxPanX=0;lightboxPanY=0}applyLightboxTransform()}
function resetLightbox(){lightboxScale=1;lightboxPanX=0;lightboxPanY=0;applyLightboxTransform()}
function handleLightbox(action){if(action==='close')closeLightbox();if(action==='download')toast('演示页不包含真实生成文件');if(action==='zoom-in')setLightboxScale(lightboxScale+.25);if(action==='zoom-out')setLightboxScale(lightboxScale-.25);if(action==='reset')resetLightbox();if(action==='previous'||action==='next'){lightboxIndex=(lightboxIndex+(action==='previous'?-1:1)+lightboxItems.length)%lightboxItems.length;updateLightbox()}}

function startNodeInteraction(event,nodeElement,node){
  if(event.target.closest('.resize-handle')){interaction={type:'resize',id:node.id,startX:event.clientX,startW:node.w};return}
  if(referencePickMode){if(event.shiftKey)toggleReference(node.id);else toast('请按住 Shift 再左键选择参考图');return}
  selectNode(node.id,false);const selected=nodes.filter(item=>selectedIds.has(item.id));interaction={type:'node',startX:event.clientX,startY:event.clientY,origins:selected.map(item=>({id:item.id,x:item.x,y:item.y})),moved:false}
}

function startCanvasInteraction(event){
  if(event.button!==0&&event.button!==1)return;interaction={type:'pan',moved:false,startX:event.clientX,startY:event.clientY,x:view.x,y:view.y};$('#canvas-viewport').setPointerCapture(event.pointerId);$('#canvas-viewport').classList.add('panning')
}

document.addEventListener('DOMContentLoaded',()=>{
  const viewport=$('#canvas-viewport');
  document.body.classList.add('nav-peek');setTimeout(()=>document.body.classList.remove('nav-peek'),1400);
  document.addEventListener('pointermove',event=>document.body.classList.toggle('nav-hover',event.clientY<18));
  document.querySelectorAll('.nav-tab').forEach(button=>button.addEventListener('click',()=>switchView(button.dataset.view)));
  document.querySelector('[data-action="add-note"]').addEventListener('click',addNote);
  document.querySelector('[data-action="fit-view"]').addEventListener('click',fitView);
  document.querySelector('[data-action="zoom-in"]').addEventListener('click',()=>zoomCanvas(view.scale+.1));
  document.querySelector('[data-action="zoom-out"]').addEventListener('click',()=>zoomCanvas(view.scale-.1));
  document.querySelector('[data-action="zoom-reset"]').addEventListener('click',()=>{view.scale=1;applyViewport()});
  document.querySelector('[data-view-jump="history"]').addEventListener('click',()=>switchView('history'));
  document.querySelector('[data-view-jump="projects"]').addEventListener('click',()=>{saveActiveProject();switchView('projects')});
  $('#new-project-form').addEventListener('submit',event=>{event.preventDefault();const name=$('#new-project-name').value.trim();if(!name)return;const id=`p${Date.now()}`;projects.unshift({id,name,updated:'刚刚',art:projects.length%palettes.length});projectStates[id]={nodes:[],tasks:[],view:{x:100,y:80,scale:1},references:[]};$('#new-project-name').value='';renderProjects();toast('项目已创建，自动拥有一张独立画布')});
  $('#project-grid').addEventListener('click',event=>{const action=event.target.closest('[data-project-action]'),card=event.target.closest('[data-project-id]');if(!action||!card)return;const id=card.dataset.projectId,project=projects.find(item=>item.id===id);if(action.dataset.projectAction==='open')openProject(id);if(action.dataset.projectAction==='rename'){const name=prompt('修改项目名称',project.name)?.trim();if(name){project.name=name;if(id===activeProjectId)$('#canvas-project-name').textContent=name;renderProjects()}}if(action.dataset.projectAction==='archive'){projects=projects.filter(item=>item.id!==id);delete projectStates[id];if(activeProjectId===id)activeProjectId=projects[0]?.id||null;renderProjects();toast('项目已归档，生成记录仍会保留')}});
  $('#account-menu-button').addEventListener('click',event=>{event.stopPropagation();$('#account-menu').classList.toggle('open')});
  $('#account-menu').addEventListener('click',event=>{const role=event.target.closest('[data-demo-role]')?.dataset.demoRole;if(role)setDemoRole(role)});
  document.addEventListener('click',event=>{if(!event.target.closest('.account'))$('#account-menu').classList.remove('open')});
  $('#reference-picker-button').addEventListener('click',()=>{referencePickMode=!referencePickMode;renderSelectedAssets();toast(referencePickMode?'参考图选择已开启：按 Shift＋左键选择图片':'参考图选择已完成')});
  $('#exit-inspection').addEventListener('click',exitInspection);
  $('#copy-prompt').addEventListener('click',async()=>{try{await navigator.clipboard.writeText($('#prompt').value);toast('提示词已复制')}catch{toast('浏览器未允许复制，请手动复制')}});
  $('#prompt-to-note').addEventListener('click',()=>addNote($('#prompt').value));
  $('#prompt-to-note').addEventListener('dragstart',event=>{event.dataTransfer.setData('text/x-image-hub-prompt',$('#prompt').value);event.dataTransfer.effectAllowed='copy'});
  $('#selected-assets-list').addEventListener('click',event=>{const remove=event.target.closest('[data-remove-reference]');if(!remove)return;referenceOrder=referenceOrder.filter(id=>id!==remove.dataset.removeReference);renderCanvas()});
  $('#selected-assets-list').addEventListener('dragstart',event=>{const chip=event.target.closest('[data-reference-id]');if(!chip)return;event.dataTransfer.setData('text/reference-id',chip.dataset.referenceId);event.dataTransfer.effectAllowed='move'});
  $('#selected-assets-list').addEventListener('dragover',event=>{if(event.target.closest('[data-reference-id]'))event.preventDefault()});
  $('#selected-assets-list').addEventListener('drop',event=>{const target=event.target.closest('[data-reference-id]'),source=event.dataTransfer.getData('text/reference-id');if(!target||!source||source===target.dataset.referenceId)return;event.preventDefault();const from=referenceOrder.indexOf(source),to=referenceOrder.indexOf(target.dataset.referenceId);if(from<0||to<0)return;referenceOrder.splice(from,1);referenceOrder.splice(to,0,source);renderCanvas()});
  $('#prompt').addEventListener('input',event=>$('#prompt-count').textContent=event.target.value.length);
  $('#provider-select').addEventListener('change',renderModels);$('#model-select').addEventListener('change',renderResolutions);
  $('#generation-form').addEventListener('submit',event=>{event.preventDefault();createGeneration()});
  $('#canvas-upload').addEventListener('change',event=>{const rect=viewport.getBoundingClientRect();addUploadedFiles(event.target.files,worldPoint(rect.left+rect.width/2,rect.top+rect.height/2));event.target.value=''});
  viewport.addEventListener('dragover',event=>event.preventDefault());viewport.addEventListener('drop',event=>{event.preventDefault();const promptText=event.dataTransfer.getData('text/x-image-hub-prompt');if(promptText){addNote(promptText,worldPoint(event.clientX,event.clientY));return}addUploadedFiles(event.dataTransfer.files,worldPoint(event.clientX,event.clientY))});
  viewport.addEventListener('wheel',event=>{event.preventDefault();zoomCanvas(view.scale*(event.deltaY<0?1.1:.9),event.clientX,event.clientY)},{passive:false});
  $('#minimap').addEventListener('pointerdown',event=>{event.stopPropagation();interaction={type:'minimap'};panFromMinimap(event.clientX,event.clientY)});
  viewport.addEventListener('pointerdown',event=>{if(event.target.closest('.canvas-node'))return;startCanvasInteraction(event)});
  $('#canvas-nodes').addEventListener('pointerdown',event=>{const element=event.target.closest('.canvas-node');if(!element||event.target.closest('.node-actions')||event.target.isContentEditable)return;event.preventDefault();const node=nodes.find(item=>item.id===element.dataset.nodeId);if(referencePickMode){startNodeInteraction(event,element,node);return}const now=performance.now();if(lastNodePress&&lastNodePress.id===node.id&&now-lastNodePress.time<420){lastNodePress=null;if(node.type!=='note'&&taskForNode(node)?.status!=='running')openNodeLightbox(node.id);return}lastNodePress={id:node.id,time:now};startNodeInteraction(event,element,node)});
  document.addEventListener('pointermove',event=>{if(!interaction)return;if(interaction.type==='minimap'){panFromMinimap(event.clientX,event.clientY);return}if(interaction.type==='pan'){if(Math.hypot(event.clientX-interaction.startX,event.clientY-interaction.startY)>5)interaction.moved=true;view.x=interaction.x+event.clientX-interaction.startX;view.y=interaction.y+event.clientY-interaction.startY;applyViewport()}if(interaction.type==='node'){if(Math.hypot(event.clientX-interaction.startX,event.clientY-interaction.startY)>5)interaction.moved=true;for(const origin of interaction.origins){const node=nodes.find(item=>item.id===origin.id);node.x=origin.x+(event.clientX-interaction.startX)/view.scale;node.y=origin.y+(event.clientY-interaction.startY)/view.scale}renderCanvas()}if(interaction.type==='resize'){const node=nodes.find(item=>item.id===interaction.id);node.w=Math.max(150,interaction.startW+(event.clientX-interaction.startX)/view.scale);renderCanvas()}});
  document.addEventListener('pointerup',()=>{const completed=interaction;interaction=null;viewport.classList.remove('panning');document.querySelectorAll('.canvas-node.dragging').forEach(node=>node.classList.remove('dragging'));if(completed?.type==='pan'&&!completed.moved){if(inspectedNodeId&&!referencePickMode){exitInspection()}else{selectedIds.clear();renderSelectedAssets();document.querySelectorAll('.canvas-node').forEach(node=>node.classList.remove('selected'))}}if(completed?.type==='node'&&!completed.moved){const id=completed.origins[0]?.id,node=nodes.find(item=>item.id===id);if(node?.type==='result'&&taskForNode(node)?.status==='succeeded')inspectResult(node)}});
  $('#canvas-nodes').addEventListener('dblclick',event=>{const element=event.target.closest('.canvas-node');if(!element)return;const node=nodes.find(item=>item.id===element.dataset.nodeId);if(node&&node.type!=='note'&&taskForNode(node)?.status!=='running')openNodeLightbox(node.id)});
  $('#canvas-nodes').addEventListener('click',event=>{const action=event.target.closest('[data-node-action]');if(!action)return;const nodeElement=event.target.closest('.canvas-node'),id=nodeElement.dataset.nodeId;if(action.dataset.nodeAction==='delete'){nodes=nodes.filter(node=>node.id!==id);selectedIds.delete(id);referenceOrder=referenceOrder.filter(item=>item!==id)}else{const source=nodes.find(node=>node.id===id);nodes.push({...source,id:`${source.id}-copy-${Date.now()}`,x:source.x+40,y:source.y+40,parents:[]})}renderCanvas()});
  document.body.addEventListener('click',event=>{const action=event.target.closest('[data-action]');if(!action||action.closest('.canvas-view'))return;const task=tasks.find(item=>item.id===action.dataset.id);if(action.dataset.action==='preview-task')openLightbox(task.id);if(action.dataset.action==='locate')locateTask(task.id);if(action.dataset.action==='reuse'){locateTask(task.id);$('#prompt').value=task.prompt;$('#prompt-count').textContent=task.prompt.length;toast('已载入历史提示词')}if(action.dataset.action==='sentiment'){task.sentiment=action.dataset.value;renderHistory();toast(`已标记为${sentimentLabels[action.dataset.value]}`)}});
  ['#search-input','#filter-provider','#filter-sentiment'].forEach(selector=>$(selector).addEventListener(selector==='#search-input'?'input':'change',renderHistory));
  $('#fake-create-user').addEventListener('click',()=>toast('这是静态演示，未创建真实账号'));
  $('#lightbox').addEventListener('click',event=>{const button=event.target.closest('[data-lightbox-action]');if(button)handleLightbox(button.dataset.lightboxAction);else if(event.target===$('#lightbox'))closeLightbox()});
  document.querySelector('.lightbox-stage').addEventListener('wheel',event=>{event.preventDefault();setLightboxScale(lightboxScale+(event.deltaY<0?.15:-.15))},{passive:false});
  const lightboxArt=$('#lightbox-art');lightboxArt.addEventListener('pointerdown',event=>{event.preventDefault();lightboxDrag={x:event.clientX,y:event.clientY,panX:lightboxPanX,panY:lightboxPanY};lightboxArt.setPointerCapture(event.pointerId);lightboxArt.classList.add('dragging')});lightboxArt.addEventListener('pointermove',event=>{if(!lightboxDrag)return;lightboxPanX=lightboxDrag.panX+event.clientX-lightboxDrag.x;lightboxPanY=lightboxDrag.panY+event.clientY-lightboxDrag.y;applyLightboxTransform()});const endLightboxDrag=event=>{if(!lightboxDrag)return;lightboxDrag=null;lightboxArt.classList.remove('dragging');if(lightboxArt.hasPointerCapture(event.pointerId))lightboxArt.releasePointerCapture(event.pointerId)};lightboxArt.addEventListener('pointerup',endLightboxDrag);lightboxArt.addEventListener('pointercancel',endLightboxDrag);
  document.addEventListener('keydown',event=>{if($('#lightbox').open){if(event.key==='Escape')closeLightbox();if(event.key==='ArrowLeft')handleLightbox('previous');if(event.key==='ArrowRight')handleLightbox('next');return}if((event.key==='Delete'||event.key==='Backspace')&&!event.target.matches('textarea,input,[contenteditable]')){nodes=nodes.filter(node=>!selectedIds.has(node.id));selectedIds.clear();referenceOrder=[];renderCanvas()}});
  renderModels();renderStatus();renderHistory();renderCanvas();renderProjects();setDemoRole('user');switchView(location.hash.slice(1)||'projects');if(location.hash==='#create')requestAnimationFrame(fitView);setTimeout(()=>{const running=tasks.find(task=>task.id==='a3');if(running){running.status='succeeded';$('#queue-count').textContent='0';renderCanvas();renderHistory()}},3500);
});