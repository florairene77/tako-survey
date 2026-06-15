import { SUPABASE_URL, SUPABASE_KEY, BUCKET, EDIT_PASSWORD, VIEW_PASSWORD } from "./config.js";

const { createClient } = window.supabase;        // 本地 vendor/supabase.js（全局 UMD）
const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

// Leaflet 默认标记图标指向本地 vendor 图片
if(window.L){
  delete L.Icon.Default.prototype._getIconUrl;
  L.Icon.Default.mergeOptions({
    iconUrl:"vendor/images/marker-icon.png",
    iconRetinaUrl:"vendor/images/marker-icon-2x.png",
    shadowUrl:"vendor/images/marker-shadow.png"
  });
}
const app = document.getElementById("app");
const backbtn = document.getElementById("backbtn");

/* ---------------- 登录 ---------------- */
const gate = document.getElementById("gate");
function unlocked(){ return !!sessionStorage.getItem("tako_role"); }
function canEdit(){ return sessionStorage.getItem("tako_role") === "editor"; }
function applyRoleBadge(){
  const b=document.getElementById("rolebadge"); if(!b) return;
  if(!unlocked()){ b.textContent=""; b.className="rolebadge"; return; }
  if(canEdit()){ b.textContent="编辑模式"; b.className="rolebadge edit"; }
  else { b.textContent="查看模式"; b.className="rolebadge view"; }
}
function tryUnlock(){
  const pw = document.getElementById("gate-pw").value.trim();
  let role=null;
  if(pw === EDIT_PASSWORD) role="editor";
  else if(pw === VIEW_PASSWORD) role="viewer";
  if(role){
    sessionStorage.setItem("tako_role",role);
    gate.style.display="none";
    applyRoleBadge();
    route();
  }else{
    document.getElementById("gate-err").textContent="密码不对，再试一次";
  }
}
document.getElementById("gate-btn").onclick = tryUnlock;
document.getElementById("gate-pw").addEventListener("keydown",e=>{ if(e.key==="Enter") tryUnlock(); });
if(unlocked()){ gate.style.display="none"; applyRoleBadge(); }

/* 记住名字（踏勘说明署名 / 上传人） */
function whoami(){
  let n = localStorage.getItem("tako_name");
  if(!n){ n = prompt("第一次使用，请输入你的名字（用于标记是谁上传/记录的）：")||"同事"; localStorage.setItem("tako_name",n.trim()||"同事"); }
  return n;
}

/* 写一条编辑记录（失败不阻断主流程） */
async function logAct(venueId, action, target){
  try{ await sb.from("activity_log").insert({venue_id:venueId, who:whoami(), action, target:target||null}); }
  catch(e){ /* 记录失败不影响主操作 */ }
}

/* ---------------- 工具 ---------------- */
const toastEl = document.getElementById("toast");
let toastT;
function toast(msg){ toastEl.textContent=msg; toastEl.classList.add("on"); clearTimeout(toastT); toastT=setTimeout(()=>toastEl.classList.remove("on"),2200); }
function pubUrl(path, v){ const u = sb.storage.from(BUCKET).getPublicUrl(path).data.publicUrl; return v? u+"?v="+encodeURIComponent(v): u; }
function esc(s){ return (s??"").toString().replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c])); }

// 浏览器内压缩：最长边 1600，JPEG 0.82
async function compress(file){
  const bmp = await createImageBitmap(file).catch(()=>null);
  let img = bmp;
  if(!img){ img = await new Promise((res,rej)=>{ const i=new Image(); i.onload=()=>res(i); i.onerror=rej; i.src=URL.createObjectURL(file); }); }
  const MAX=1600; let {width:w,height:h}= img;
  if(Math.max(w,h)>MAX){ const r=MAX/Math.max(w,h); w=Math.round(w*r); h=Math.round(h*r); }
  const c=document.createElement("canvas"); c.width=w; c.height=h;
  c.getContext("2d").drawImage(img,0,0,w,h);
  return await new Promise(res=>c.toBlob(res,"image/jpeg",0.82));
}

/* ---------------- 路由 ---------------- */
window.addEventListener("hashchange", route);
backbtn.onclick = ()=> location.hash = "#/";
function route(){
  if(!unlocked()){ gate.style.display="flex"; return; }
  const m = location.hash.match(/#\/venue\/([\w-]+)/);
  if(m){ backbtn.style.display="block"; renderDetail(m[1]); }
  else { backbtn.style.display="none"; renderHome(); }
  window.scrollTo(0,0);
}

/* ---------------- 首页 ---------------- */
const CAT_ALL = "全部";
let homeMap;
async function renderHome(){
  app.innerHTML = `<div class="loading">加载场馆…</div>`;
  const { data:venues, error } = await sb.from("venues")
    .select("*, venue_photos(storage_path)")
    .order("sort_order");
  if(error){ app.innerHTML=`<div class="loading">读取失败：${esc(error.message)}</div>`; return; }

  const cats = [CAT_ALL, ...Array.from(new Set(venues.map(v=>v.category).filter(Boolean)))];
  let active = CAT_ALL;

  function draw(){
    const list = active===CAT_ALL? venues : venues.filter(v=>v.category===active);
    const totalSlots = venues.reduce((a,v)=>a+(v.venue_photos?.length||0),0);
    const filled = venues.reduce((a,v)=>a+(v.venue_photos?.filter(p=>p.storage_path).length||0),0);
    app.innerHTML = `
      <div class="hero">
        <h2>场馆踏勘资料库</h2>
        <p>餐饮 · 住宿 · 交通一站汇总 · 现场点坑位即拍即传</p>
        <div class="stats">
          <div class="stat"><b>${venues.length}</b><span>场馆</span></div>
          <div class="stat"><b>${filled}/${totalSlots}</b><span>照片坑位已填</span></div>
          <div class="stat"><b>${cats.length-1}</b><span>比赛项目</span></div>
        </div>
      </div>
      <div id="map"></div>
      <div class="filters">${cats.map(c=>`<button class="chip ${c===active?'on':''}" data-c="${esc(c)}">${esc(c)}</button>`).join("")}</div>
      <div class="grid">${list.map(cardHTML).join("")}</div>
      <div class="foot">内部资料 · 仅供 HB 后勤组使用</div>`;
    app.querySelectorAll(".chip").forEach(ch=>ch.onclick=()=>{ active=ch.dataset.c; draw(); });
    app.querySelectorAll(".vcard").forEach(el=>el.onclick=()=>location.hash="#/venue/"+el.dataset.id);
    drawMap(list);
  }
  function cardHTML(v){
    const slots = v.venue_photos||[]; const tot=slots.length||15;
    const fl = slots.filter(p=>p.storage_path).length;
    const cover = slots.find(p=>p.storage_path);
    const coverUrl = cover? pubUrl(cover.storage_path) : null;
    const pct = Math.round(fl/tot*100);
    return `<div class="vcard" data-id="${v.id}">
      <div class="thumb" style="${coverUrl?`background-image:url('${coverUrl}')`:''}">
        <span class="code">${esc(v.c_code||"")}</span>
      </div>
      <div class="body">
        <div class="cat">${esc(v.category||v.venue_name_jp||"")}</div>
        <div class="meta">🚌 ${esc(v.team||"—")} · ${esc(v.travel_time||"车程待测")}</div>
        <div class="meta">📍 ${esc((v.venue_name_jp||"").slice(0,14))}</div>
        <div class="prog"><i style="width:${pct}%"></i></div>
        <div class="progtxt">资料 ${fl}/${tot}</div>
      </div></div>`;
  }
  function drawMap(list){
    const pts = list.filter(v=>v.lat&&v.lng);
    setTimeout(()=>{
      if(homeMap){ homeMap.remove(); homeMap=null; }
      homeMap = L.map("map",{scrollWheelZoom:false}).setView([35.18,136.91],10);
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",{attribution:"© OpenStreetMap",maxZoom:18}).addTo(homeMap);
      const marks=[];
      pts.forEach(v=>{
        const mk=L.marker([v.lat,v.lng]).addTo(homeMap)
          .bindPopup(`<b>${esc(v.c_code)} ${esc(v.category||"")}</b><br>${esc(v.venue_name_jp||"")}`);
        mk.on("click",()=>{});
        marks.push([v.lat,v.lng]);
      });
      if(marks.length) homeMap.fitBounds(marks,{padding:[40,40],maxZoom:13});
    },60);
  }
  draw();
}

/* ---------------- 详情页 ---------------- */
const GROUP_ORDER = ["概览","场馆","酒店"];
async function renderDetail(id){
  app.innerHTML = `<div class="loading">加载场馆资料…</div>`;
  const [{data:v},{data:photos},{data:hotels},{data:events},{data:logs},{data:extras},{data:acts}] = await Promise.all([
    sb.from("venues").select("*").eq("id",id).single(),
    sb.from("venue_photos").select("*").eq("venue_id",id).order("sort_order"),
    sb.from("venue_hotels").select("*").eq("venue_id",id).order("sort_order"),
    sb.from("venue_events").select("*").eq("venue_id",id).order("sort_order"),
    sb.from("survey_logs").select("*").eq("venue_id",id).order("created_at",{ascending:false}),
    sb.from("extra_photos").select("*").eq("venue_id",id).order("created_at"),
    sb.from("activity_log").select("*").eq("venue_id",id).order("created_at",{ascending:false}).limit(40),
  ]);
  if(!v){ app.innerHTML=`<div class="loading">场馆不存在</div>`; return; }

  const groups={};
  (photos||[]).forEach(p=>{ (groups[p.slot_group]=groups[p.slot_group]||[]).push(p); });
  const filled=(photos||[]).filter(p=>p.storage_path).length;

  app.innerHTML = `
    <div class="detail-hero">
      <span class="code">${esc(v.c_code||"")}</span>
      <h2>${esc(v.category||"")}</h2>
      <div class="jp">${esc(v.venue_name_jp||"")}</div>
      <div class="kv">
        <div><div class="k">执行团队</div><div class="v">${esc(v.team||"—")}</div></div>
        <div><div class="k">实测车程</div><div class="v">${esc(v.travel_time||"待测")}</div></div>
        <div><div class="k">工作区间</div><div class="v">${fmtPeriod(v)}</div></div>
        <div><div class="k">团队人数</div><div class="v">${esc(v.team_size||"—")}</div></div>
      </div>
    </div>

    <div class="section">
      <h3><span class="dot"></span>基本信息</h3>
      <div class="hotel" style="margin-top:0">
        <div class="hmeta"><span class="lab">场馆</span><span>${esc(v.venue_name_jp||"")}</span></div>
        <div class="hmeta"><span class="lab">地址</span><span>${esc(v.venue_address||"—")}</span></div>
        <div class="hmeta"><span class="lab">最近交通</span><span>${esc(v.nearest_transit||"—")}</span></div>
        <div class="hmeta"><span class="lab">停车</span><span>${esc(v.parking_note||"—")}</span></div>
      </div>
      <div id="detmap" class="detmap" style="margin-top:12px"></div>
      ${v.venue_intro?`<div class="intro-box" style="margin-top:10px">${esc(v.venue_intro)}</div>`:""}
    </div>

    ${canEdit()?`<div class="section">
      <h3><span class="dot"></span>内部提示<span class="count">仅编辑可见 🔒</span></h3>
      <div class="intnote">
        <div class="ihd">🔒 画面外信息 · 只读密码看不到<button class="iedit" id="int-edit">编辑</button></div>
        ${v.internal_note?`<div class="ibody">${esc(v.internal_note)}</div>`:`<div class="iempty">还没有内部提示，点「编辑」添加（订餐电话、提前预约天数、店长联系方式等）</div>`}
      </div>
    </div>`:""}

    <div class="section">
      <h3><span class="dot"></span>照片资料<span class="count">${filled}/${photos?.length||0} 已填</span></h3>
      <div class="hint-line">${canEdit()?"点空坑位即可拍照/选图上传 · 长按照片加备注、点开可替换":"点照片看大图与备注 · 长按也能看备注"}</div>
      ${GROUP_ORDER.filter(g=>groups[g]).map(g=>`
        <div class="slotgroup-title">${g}${g==="概览"?"（重要 · 点开放大）":""}</div>
        ${g==="概览"
          ? `<div class="slots docs">${groups[g].map(docSlotHTML).join("")}</div>`
          : `<div class="slots">${groups[g].map(slotHTML).join("")}</div>`}
      `).join("")}
      ${((extras&&extras.length)||canEdit())?`
      <div class="slotgroup-title">补充照片（随手拍 · 不限数量）</div>
      <div class="slots" id="extra-slots">
        ${(extras||[]).map(extraHTML).join("")}
        ${canEdit()?`<div class="slot add" id="add-extra"><div class="ico">＋</div><div class="lab">加照片</div></div>`:""}
      </div>`:""}
    </div>

    <div class="section">
      <h3><span class="dot"></span>对应比赛项目<span class="count">${events?.length||0}</span></h3>
      ${(events&&events.length)? events.map(e=>`<div class="evrow"><span class="en">${esc(v.c_code||"")} · ${esc(e.name||"")}${e.name_en?` / ${esc(e.name_en)}`:""}${e.note?` / ${esc(e.note)}`:""}</span><span class="es">${esc(e.schedule||"")}</span></div>`).join("") : `<div class="muted-empty">暂无</div>`}
    </div>

    <div class="section">
      <h3><span class="dot"></span>配套酒店<span class="count">${hotels?.length||0}</span></h3>
      ${(hotels&&hotels.length)? hotels.map(hotelHTML).join("") : `<div class="muted-empty">暂无</div>`}
    </div>

    <div class="section">
      <h3><span class="dot"></span>踏勘说明<span class="count">${logs?.length||0} 条</span></h3>
      <div id="logs">${(logs&&logs.length)? logs.map(logHTML).join("") : `<div class="muted-empty">${canEdit()?"还没有记录，第一条由你来写 👇":"还没有记录"}</div>`}</div>
      ${canEdit()?`<div class="logform">
        <textarea id="log-txt" placeholder="补充这个场馆的踏勘情况，比如停车、动线、注意事项…"></textarea>
        <button class="btn" id="log-add">＋ 添加记录</button>
      </div>`:""}
    </div>

    <details class="section actlog">
      <summary><span class="dot"></span>编辑记录<span class="count">${acts?.length||0} 条 · 点击展开</span></summary>
      <div class="actlist">
        ${(acts&&acts.length)? acts.map(actHTML).join("") : `<div class="muted-empty">还没有编辑记录</div>`}
      </div>
    </details>
    <div class="foot">${esc(v.c_code)} · 资料随踏勘持续更新</div>`;

  // 地图
  setTimeout(()=>{
    const m=L.map("detmap",{scrollWheelZoom:false,zoomControl:false}).setView([v.lat||35.18,v.lng||136.91],14);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",{maxZoom:18}).addTo(m);
    if(v.lat&&v.lng) L.marker([v.lat,v.lng]).addTo(m).bindPopup("场馆："+esc(v.venue_name_jp||""));
    (hotels||[]).forEach(h=>{ if(h.lat&&h.lng) L.marker([h.lat,h.lng]).addTo(m).bindPopup("酒店："+esc(h.name||"")); });
    const pts=[[v.lat,v.lng],...(hotels||[]).filter(h=>h.lat&&h.lng).map(h=>[h.lat,h.lng])].filter(p=>p[0]&&p[1]);
    if(pts.length>1) m.fitBounds(pts,{padding:[30,30]});
    setTimeout(()=>m.invalidateSize(),250);
  },60);

  // 固定坑位（含概览大图）
  app.querySelectorAll(".slot[data-pid], .docslot[data-pid]").forEach(el=>{
    const get=()=>(photos||[]).find(x=>x.id===el.dataset.pid);
    if(!get().storage_path){ // 空坑位
      if(canEdit()) el.onclick=()=>pickAndUpload(get(), el, id);
      return;
    }
    bindPhoto(el,
      ()=>openLightbox({kind:"slot",rec:get(),venueId:id}),
      ()=>openNote({kind:"slot",rec:get(),venueId:id}));
  });
  // 内部提示编辑（仅编辑）
  const intEdit=app.querySelector("#int-edit");
  if(intEdit) intEdit.onclick=()=>openTextEditor("内部提示（仅编辑可见）", v.internal_note||"", async(val)=>{
    const {error}=await sb.from("venues").update({internal_note:val||null}).eq("id",id);
    if(error){ toast("保存失败"); return; }
    await logAct(id,"编辑内部提示",null); toast("已保存"); renderDetail(id);
  });
  // 酒店编辑（仅编辑）
  app.querySelectorAll(".hedit").forEach(btn=>{
    btn.onclick=(e)=>{ e.stopPropagation(); const h=(hotels||[]).find(x=>x.id===btn.dataset.hid); if(h) openHotelEditor(h, id); };
  });
  // 补充照片
  app.querySelectorAll(".slot[data-eid]").forEach(el=>{
    const get=()=>(extras||[]).find(x=>x.id===el.dataset.eid);
    bindPhoto(el,
      ()=>openLightbox({kind:"extra",rec:get(),venueId:id}),
      ()=>openNote({kind:"extra",rec:get(),venueId:id}));
  });
  const addEl=app.querySelector("#add-extra");
  if(addEl && canEdit()) addEl.onclick=()=>addExtraPhoto(id, addEl);
  // 踏勘说明（仅编辑权限可添加）
  const logAdd=app.querySelector("#log-add");
  if(logAdd) logAdd.onclick=async()=>{
    const txt=app.querySelector("#log-txt").value.trim();
    if(!txt){ toast("写点内容再添加"); return; }
    const author=whoami();
    const {error}=await sb.from("survey_logs").insert({venue_id:id,author,content:txt});
    if(error){ toast("保存失败"); return; }
    await logAct(id, "写了踏勘说明", null);
    toast("已添加"); renderDetail(id);
  };
}

function fmtPeriod(v){
  if(!v.work_start) return v.work_days? v.work_days+"天":"—";
  const f=d=>{ if(!d) return ""; const [y,mo,da]=d.split("-"); return `${+mo}/${+da}`; };
  return `${f(v.work_start)}–${f(v.work_end)}${v.work_days?` (${v.work_days}天)`:""}`;
}
function slotHTML(p){
  if(p.storage_path){
    const note=(p.note||"").trim();
    const strip = note ? `<span class="cap note">${esc(note)}</span>` : (p.caption?`<span class="cap">${esc(p.caption)}</span>`:"");
    return `<div class="slot filled${note?" hasnote":""}" data-pid="${p.id}"${note?` title="${esc(note)}"`:""}>
      <img loading="lazy" src="${pubUrl(p.storage_path,p.updated_at)}" alt="${esc(p.slot_label)}">
      ${note?`<div class="notebadge">★</div>`:""}
      <div class="caption"><span class="lab">${esc(p.slot_label)}</span>${strip}</div>
    </div>`;
  }
  if(!canEdit()){
    return `<div class="slot empty" data-pid="${p.id}">
      <div class="ico">📷</div><div class="lab">${esc(p.slot_label)}</div><div class="hint">暂无照片</div></div>`;
  }
  return `<div class="slot empty" data-pid="${p.id}">
    <div class="ico">${p.slot_type==="paste"?"🖼️":"📷"}</div>
    <div class="lab">${esc(p.slot_label)}</div>
    <div class="hint">${p.slot_type==="paste"?"点击选图":"点击拍照"}${p.caption?` · ${esc(p.caption)}`:""}</div>
  </div>`;
}
function extraHTML(e){
  const note=(e.note||e.caption||"").trim(); // 兼容旧数据
  return `<div class="slot filled${note?" hasnote":""}" data-eid="${e.id}"${note?` title="${esc(note)}"`:""}>
    <img loading="lazy" src="${pubUrl(e.storage_path,e.created_at)}" alt="补充照片">
    ${note?`<div class="notebadge">★</div>`:""}
    <div class="caption"><span class="lab">补充照片</span>${note?`<span class="cap note">${esc(note)}</span>`:""}</div>
  </div>`;
}
function docSlotHTML(p){
  if(p.storage_path){
    const note=(p.note||"").trim();
    const sub = note ? note : (p.caption||"");
    return `<div class="docslot${note?" hasnote":""}" data-pid="${p.id}"${note?` title="${esc(note)}"`:""}>
      <img loading="lazy" src="${pubUrl(p.storage_path,p.updated_at)}" alt="${esc(p.slot_label)}">
      <span class="dzoom">🔍 点开放大</span>
      <div class="dlabel">${note?`<span class="star">★</span>`:""}${esc(p.slot_label)}${sub?` · ${esc(sub)}`:""}</div>
    </div>`;
  }
  if(!canEdit()) return `<div class="docslot empty"><div class="ico">🖼️</div><div class="lab">${esc(p.slot_label)} · 暂无</div></div>`;
  return `<div class="docslot empty" data-pid="${p.id}"><div class="ico">${p.slot_type==="paste"?"🖼️":"📷"}</div><div class="lab">${esc(p.slot_label)} · 点击上传</div></div>`;
}
function hotelHTML(h){
  return `<div class="hotel">
    ${canEdit()?`<button class="hedit" data-hid="${h.id}">编辑</button>`:""}
    <div class="hn">🏨 ${esc(h.name||"")}</div>
    <div class="hmeta"><span class="lab">地址</span><span>${esc(h.address||"—")}</span></div>
    <div class="hmeta"><span class="lab">房型</span><span>${esc(h.room_type||"—")}</span></div>
    <div class="hmeta"><span class="lab">最近交通</span><span>${esc(h.nearest_transit||"—")}</span></div>
    ${h.url?`<div class="hmeta"><span class="lab">官网</span><a href="${esc(h.url)}" target="_blank" rel="noopener" style="color:var(--accent)">打开官网 ↗</a></div>`:""}
    ${h.hotel_intro?`<div class="intro">${esc(h.hotel_intro)}</div>`:""}
  </div>`;
}
function actHTML(a){
  const d=new Date(a.created_at);
  const ds=`${d.getMonth()+1}/${d.getDate()} ${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}`;
  return `<div class="actrow"><span class="aw"><b>${esc(a.who||"某人")}</b> ${esc(a.action||"")}${a.target?` 〔${esc(a.target)}〕`:""}</span><span class="at">${ds}</span></div>`;
}
function logHTML(l){
  const d=new Date(l.created_at); const ds=`${d.getMonth()+1}/${d.getDate()} ${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}`;
  return `<div class="log"><div class="meta"><b>${esc(l.author||"同事")}</b> · ${ds}</div><div class="txt">${esc(l.content)}</div></div>`;
}

/* ---------------- 上传 ---------------- */
function pickAndUpload(p, el){
  const input=document.createElement("input");
  input.type="file"; input.accept="image/*";
  if(p.slot_type!=="paste") input.capture="environment"; // 拍照类直接调相机
  input.onchange=async()=>{
    const file=input.files[0]; if(!file) return;
    const wasReplace=!!p.storage_path;
    el.classList.add("uploading");
    try{
      const blob=await compress(file);
      const path=`${p.venue_id}/${p.slot_key}.jpg`;
      const {error:upErr}=await sb.storage.from(BUCKET).upload(path,blob,{upsert:true,contentType:"image/jpeg"});
      if(upErr) throw upErr;
      const {error:dbErr}=await sb.from("venue_photos").update({storage_path:path,uploaded_by:whoami(),updated_at:new Date().toISOString()}).eq("id",p.id);
      if(dbErr) throw dbErr;
      await logAct(p.venue_id, wasReplace?"替换照片":"上传照片", p.slot_label);
      toast(wasReplace?"已替换 ✓":"上传成功 ✓");
      const id=p.venue_id; renderDetail(id);
    }catch(e){ console.error(e); toast("上传失败："+(e.message||e)); el.classList.remove("uploading"); }
  };
  input.click();
}

/* 补充照片：随手拍，不限数量，可加备注 */
function addExtraPhoto(venueId, el){
  const input=document.createElement("input");
  input.type="file"; input.accept="image/*"; input.capture="environment";
  input.onchange=async()=>{
    const file=input.files[0]; if(!file) return;
    el.classList.add("uploading");
    try{
      const blob=await compress(file);
      const key=`extra/${venueId}/${Date.now()}-${Math.round(performance.now())}.jpg`;
      const {error:upErr}=await sb.storage.from(BUCKET).upload(key,blob,{upsert:true,contentType:"image/jpeg"});
      if(upErr) throw upErr;
      const note=(prompt("给这张照片加个备注（可留空，之后长按照片也能加）：")||"").trim();
      const {error:dbErr}=await sb.from("extra_photos").insert({venue_id:venueId,storage_path:key,note:note||null,uploaded_by:whoami()});
      if(dbErr) throw dbErr;
      await logAct(venueId, "添加补充照片", note||"补充照片");
      toast("已添加 ✓"); renderDetail(venueId);
    }catch(e){ console.error(e); toast("上传失败："+(e.message||e)); el.classList.remove("uploading"); }
  };
  input.click();
}

/* ---------------- 照片交互：短按看大图 / 长按看备注 ---------------- */
function noteOf(ctx){ const r=ctx.rec; return (r.note || (ctx.kind==="extra"? r.caption : "") || ""); }
function bindPhoto(el, onTap, onLong){
  let timer=null, longFired=false;
  const start=()=>{ longFired=false; timer=setTimeout(()=>{ longFired=true; onLong(); }, 480); };
  const cancel=()=>{ clearTimeout(timer); };
  el.addEventListener("touchstart",start,{passive:true});
  el.addEventListener("touchend",cancel);
  el.addEventListener("touchmove",cancel,{passive:true});
  el.addEventListener("mousedown",start);
  el.addEventListener("mouseup",cancel);
  el.addEventListener("mouseleave",cancel);
  el.addEventListener("contextmenu",e=>e.preventDefault());
  el.addEventListener("click",e=>{ if(longFired){ e.preventDefault(); longFired=false; return; } onTap(); });
}

/* ---------------- 备注弹窗（长按触发） ---------------- */
const notem=document.getElementById("notem");
let noteCtx=null;
function openNote(ctx){
  noteCtx=ctx;
  const note=noteOf(ctx).trim();
  const editing=canEdit();
  const ta=document.getElementById("notem-text");
  const view=document.getElementById("notem-view");
  document.getElementById("notem-title").textContent=editing?"编辑备注":"备注";
  document.getElementById("notem-save").style.display=editing?"":"none";
  document.getElementById("notem-cancel").textContent=editing?"取消":"关闭";
  if(editing){ ta.style.display="block"; view.style.display="none"; ta.value=note; }
  else{ ta.style.display="none"; view.style.display="block"; view.textContent=note||"（这张照片还没有备注）"; }
  notem.classList.add("on");
  if(editing) setTimeout(()=>ta.focus(),50);
}
async function saveNote(){
  if(!noteCtx) return;
  const val=document.getElementById("notem-text").value.trim();
  const table=noteCtx.kind==="slot"?"venue_photos":"extra_photos";
  const {error}=await sb.from(table).update({note:val||null}).eq("id",noteCtx.rec.id);
  if(error){ toast("保存失败"); return; }
  await logAct(noteCtx.venueId, "编辑备注", noteCtx.kind==="slot"?noteCtx.rec.slot_label:"补充照片");
  notem.classList.remove("on"); toast("备注已保存"); renderDetail(noteCtx.venueId);
}
document.getElementById("notem-save").onclick=saveNote;
document.getElementById("notem-cancel").onclick=()=>notem.classList.remove("on");
notem.addEventListener("click",e=>{ if(e.target===notem) notem.classList.remove("on"); });

/* ---------------- 通用文字编辑（内部提示等） ---------------- */
const textm=document.getElementById("textm");
let textmSave=null;
function openTextEditor(title, value, onSave){
  document.getElementById("textm-title").textContent=title;
  document.getElementById("textm-text").value=value||"";
  textmSave=onSave;
  textm.classList.add("on");
  setTimeout(()=>document.getElementById("textm-text").focus(),50);
}
document.getElementById("textm-cancel").onclick=()=>textm.classList.remove("on");
document.getElementById("textm-save").onclick=async()=>{ const val=document.getElementById("textm-text").value.trim(); if(textmSave) await textmSave(val); textm.classList.remove("on"); };
textm.addEventListener("click",e=>{ if(e.target===textm) textm.classList.remove("on"); });

/* ---------------- 酒店编辑 ---------------- */
const hotelm=document.getElementById("hotelm");
let hotelEditing=null;
function openHotelEditor(h, venueId){
  hotelEditing={id:h.id, venueId};
  document.getElementById("hm-name").value=h.name||"";
  document.getElementById("hm-address").value=h.address||"";
  document.getElementById("hm-room").value=h.room_type||"";
  document.getElementById("hm-transit").value=h.nearest_transit||"";
  document.getElementById("hm-travel").value=h.travel_time||"";
  document.getElementById("hm-url").value=h.url||"";
  document.getElementById("hm-intro").value=h.hotel_intro||"";
  hotelm.classList.add("on");
}
document.getElementById("hm-cancel").onclick=()=>hotelm.classList.remove("on");
document.getElementById("hm-save").onclick=async()=>{
  if(!hotelEditing) return;
  const g=id=>document.getElementById(id).value.trim();
  const upd={ name:g("hm-name")||null, address:g("hm-address")||null, room_type:g("hm-room")||null,
    nearest_transit:g("hm-transit")||null, travel_time:g("hm-travel")||null, url:g("hm-url")||null, hotel_intro:g("hm-intro")||null };
  const {error}=await sb.from("venue_hotels").update(upd).eq("id",hotelEditing.id);
  if(error){ toast("保存失败"); return; }
  await logAct(hotelEditing.venueId,"编辑酒店信息", upd.name||"酒店");
  hotelm.classList.remove("on"); toast("已保存"); renderDetail(hotelEditing.venueId);
};
hotelm.addEventListener("click",e=>{ if(e.target===hotelm) hotelm.classList.remove("on"); });

/* ---------------- lightbox ---------------- */
const lb=document.getElementById("lb");
const lbActs=document.getElementById("lb-acts");
let lbCtx=null; // {kind:'slot'|'extra', rec, venueId}
function openLightbox(ctx){
  lbCtx=ctx; const r=ctx.rec;
  const ver = ctx.kind==="slot"? r.updated_at : r.created_at;
  document.getElementById("lb-img").src=pubUrl(r.storage_path,ver);
  const label = ctx.kind==="slot"? r.slot_label : "补充照片";
  const preset = (ctx.kind==="slot" && r.caption) ? r.caption : "";
  const note = noteOf(ctx).trim();
  let cap=label; if(preset) cap+=" · "+preset; if(note) cap+="\n📝 "+note;
  document.getElementById("lb-cap").textContent=cap;
  // 按钮（编辑权限 + 麦当劳彩蛋）
  let html="";
  if(canEdit()){
    html+=`<button id="lb-note">${note?"编辑备注":"加备注"}</button>`;
    html+=`<button id="lb-replace">替换这张</button>`;
    if(ctx.kind==="extra") html+=`<button id="lb-del" class="danger">删除</button>`;
  }
  if(r.is_mcd) html+=`<button id="lb-mcd" class="mcd">🔊 麦门 BGM</button>`;
  lbActs.innerHTML=html;
  if(canEdit()){
    lbActs.querySelector("#lb-note").onclick=()=>{ lb.classList.remove("on"); openNote(ctx); };
    lbActs.querySelector("#lb-replace").onclick=replaceCur;
    const del=lbActs.querySelector("#lb-del"); if(del) del.onclick=deleteExtra;
  }
  const mcd=lbActs.querySelector("#lb-mcd");
  if(mcd) mcd.onclick=()=>playJingle(mcd);
  lb.classList.add("on");
}

/* ---------------- 麦当劳彩蛋：原创洗脑小调（Web Audio，约30秒） ---------------- */
let jingleCtx=null, jingleStop=null;
function tone(ctx,dest,freq,start,dur,type,vol){
  const o=ctx.createOscillator(); o.type=type; o.frequency.value=freq;
  const g=ctx.createGain();
  g.gain.setValueAtTime(0.0001,start);
  g.gain.linearRampToValueAtTime(vol,start+0.02);
  g.gain.exponentialRampToValueAtTime(0.0008,start+dur);
  o.connect(g); g.connect(dest);
  o.start(start); o.stop(start+dur+0.03);
}
function playJingle(btn){
  if(jingleCtx){ stopJingle(); return; }   // 再点一次=停止
  const ctx=new (window.AudioContext||window.webkitAudioContext)();
  jingleCtx=ctx;
  const master=ctx.createGain(); master.gain.value=0.16; master.connect(ctx.destination);
  const step=0.19, total=30;
  // 原创动机（C 大调五声、蹦跳感；非任何既有旋律）
  const lead=[523.25,523.25,659.25,523.25, 587.33,587.33,440,0, 523.25,659.25,783.99,659.25, 698.46,587.33,523.25,0];
  const bass=[130.81,0,164.81,0, 146.83,0,110,0, 130.81,0,196.00,0, 174.61,0,130.81,0];
  let t=ctx.currentTime+0.06; const N=Math.ceil(total/step);
  for(let n=0;n<N;n++){
    const lf=lead[n%lead.length], bf=bass[n%bass.length];
    if(lf) tone(ctx,master,lf,t,step*0.92,"square",0.45);
    if(bf) tone(ctx,master,bf,t,step*0.92,"triangle",0.6);
    t+=step;
  }
  jingleStop=setTimeout(stopJingle,total*1000+200);
  if(btn){ btn.textContent="🎵 播放中…点此停止"; btn.classList.add("playing"); }
  toast("🍟 麦门 BGM，约30秒～");
}
function stopJingle(){
  if(jingleStop){ clearTimeout(jingleStop); jingleStop=null; }
  if(jingleCtx){ try{ jingleCtx.close(); }catch(e){} jingleCtx=null; }
  const b=document.getElementById("lb-mcd"); if(b){ b.textContent="🔊 麦门 BGM"; b.classList.remove("playing"); }
}
function replaceCur(){
  lb.classList.remove("on");
  const fake=document.createElement("div");
  if(lbCtx.kind==="slot"){ pickAndUpload(lbCtx.rec, fake, lbCtx.venueId); }
  else { replaceExtra(lbCtx.rec, lbCtx.venueId); }
}
function replaceExtra(e, venueId){
  const input=document.createElement("input");
  input.type="file"; input.accept="image/*"; input.capture="environment";
  input.onchange=async()=>{
    const file=input.files[0]; if(!file) return;
    try{
      const blob=await compress(file);
      const {error:upErr}=await sb.storage.from(BUCKET).upload(e.storage_path,blob,{upsert:true,contentType:"image/jpeg"});
      if(upErr) throw upErr;
      await sb.from("extra_photos").update({created_at:new Date().toISOString()}).eq("id",e.id);
      await logAct(venueId, "替换补充照片", "补充照片");
      toast("已替换 ✓"); renderDetail(venueId);
    }catch(err){ toast("替换失败"); }
  };
  input.click();
}
async function deleteExtra(){
  if(!confirm("删除这张补充照片？")) return;
  const e=lbCtx.rec;
  await sb.storage.from(BUCKET).remove([e.storage_path]).catch(()=>{});
  const {error}=await sb.from("extra_photos").delete().eq("id",e.id);
  if(error){ toast("删除失败"); return; }
  await logAct(lbCtx.venueId, "删除补充照片", "补充照片");
  lb.classList.remove("on"); toast("已删除"); renderDetail(lbCtx.venueId);
}
document.getElementById("lb-close").onclick=()=>{ stopJingle(); lb.classList.remove("on"); };
lb.addEventListener("click",e=>{ if(e.target===lb){ stopJingle(); lb.classList.remove("on"); } });

/* ---------------- 启动 ---------------- */
route();
