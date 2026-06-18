import { SUPABASE_URL, SUPABASE_KEY, BUCKET, EDIT_PASSWORD, VIEW_PASSWORD } from "./config.js?v=32";

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
let SNOTES=[], CURV=null;   // 我的笔记缓存 / 当前场馆
let _freshNav=false;        // 首次从首页/路由进入场馆=回顶部；编辑后重渲染=保留滚动位置(D1)

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
function enterApp(){ gate.style.display="none"; applyRoleBadge(); route(); }
function tryUnlock(){
  const pw = document.getElementById("gate-pw").value.trim();
  let role=null;
  if(pw === EDIT_PASSWORD) role="editor";          // 编辑 = 567（自己人）
  else if(pw === VIEW_PASSWORD) role="viewer";     // 只读 = tako2026（对外）
  if(!role){ document.getElementById("gate-err").textContent="密码不对，再试一次"; return; }
  sessionStorage.setItem("tako_role",role);
  enterApp();
}
document.getElementById("gate-btn").onclick = tryUnlock;
document.getElementById("gate-pw").addEventListener("keydown",e=>{ if(e.key==="Enter") tryUnlock(); });
if(unlocked()){ gate.style.display="none"; applyRoleBadge(); }

/* 谢谢你小章鱼：渐显→停留~1秒→渐隐 */
let _thankT=null;
function thankYou(){
  const el=document.getElementById("thankyou");
  el.classList.add("show");
  clearTimeout(_thankT);
  _thankT=setTimeout(()=>el.classList.remove("show"), 1450);
}
let VENUE_DONE=false;
function maybeThank(){ if(VENUE_DONE) thankYou(); }

/* 不再记录是谁（编辑者不分彼此），只记何时改了什么 */
function whoami(){
  return null;
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
// 简介/说明里把顺序枚举(2、3、…)前面补换行，避免和时间等数字黏在一起(如 15:302、)
function fmtIntro(t){
  if(!t) return t;
  let out=t;
  for(let n=9;n>=2;n--){ out=out.split(n+"、").join("\n"+n+"、"); }
  return out.replace(/\n{2,}/g,"\n").replace(/^\n/,"").trim();
}

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

/* ---------------- 拍照后存到手机相册（D2，网页折中：弹分享面板）---------------- */
// iOS 相机拍的文件名通常是 image.jpg；相册选的是 IMG_xxxx。据此判断"刚拍的"
function looksLikeCapture(f){ return f && /^image\.(jpe?g|png|heic|heif)$/i.test(f.name||""); }
let _albumFile=null, _albumT=null;
function offerSaveToAlbum(file){
  if(!file || !looksLikeCapture(file)) return;                       // 只对"刚拍的"弹
  if(!(navigator.canShare && navigator.canShare({files:[file]}))) return;  // 浏览器不支持就算了
  _albumFile=file;
  let btn=document.getElementById("savealbum");
  if(!btn){
    btn=document.createElement("button"); btn.id="savealbum"; btn.className="savealbum";
    document.body.appendChild(btn);
    btn.onclick=async()=>{ try{ await navigator.share({files:[_albumFile]}); }catch(e){} btn.classList.remove("on"); };
  }
  btn.textContent="📥 把刚拍的存到相册";
  btn.classList.add("on");
  clearTimeout(_albumT); _albumT=setTimeout(()=>btn.classList.remove("on"), 7000);
}

/* ---------------- 路由 ---------------- */
window.addEventListener("hashchange", route);
backbtn.onclick = ()=> location.hash = "#/";
function route(){
  if(!unlocked()){ gate.style.display="flex"; return; }
  const m = location.hash.match(/#\/venue\/([\w-]+)/);
  if(m){ backbtn.style.display="block"; _freshNav=true; renderDetail(m[1]); }
  else if(location.hash.startsWith("#/transport")){ backbtn.style.display="block"; renderTransport(); }
  else if(location.hash.startsWith("#/warehouse")){ backbtn.style.display="block"; renderWarehouse(); }
  else { backbtn.style.display="none"; renderHome(); }
  window.scrollTo(0,0);
}

/* ---------------- 首页 ---------------- */
const CAT_ALL = "全部";
const TTCOLOR = { LIVE:"#7bab95", ENG:"#e08a5d", BOTH:"#8a7bb0" };
function ttLabel(t){ return t==="ENG"?"ENG":t==="BOTH"?"LIVE+ENG":"LIVE"; }
const VIEWER_MIN_FILLED = 8;   // 只读用户：填够这么多坑位就自动对外可见（不再由踏勘完成控制）
function viewerCanSee(filled, surveyDone){ return filled>=VIEWER_MIN_FILLED; }
let homeMap;
async function renderHome(){
  app.innerHTML = `<div class="loading">加载场馆…</div>`;
  const { data:rawVenues, error } = await sb.from("venues")
    .select("*, venue_photos(storage_path,slot_key,hotel_id)")
    .order("sort_order");
  if(error){ app.innerHTML=`<div class="loading">读取失败：${esc(error.message)}</div>`; return; }

  // 按 C 码数字升序排（C07→7、C13→13），无 C 码的排最后；纯前端排序，不改库里 sort_order
  const cnum = c => { const m=/(\d+)/.exec(c||""); return m? +m[1] : 9999; };
  (rawVenues||[]).sort((a,b)=> cnum(a.c_code)-cnum(b.c_code) || ((a.sort_order||0)-(b.sort_order||0)));

  // 只读用户：只看到大部分填好的场馆，未踏勘的隐藏
  const venues = canEdit() ? rawVenues : rawVenues.filter(v=>{
    const filled=(v.venue_photos||[]).filter(p=>p.storage_path).length;
    return viewerCanSee(filled, v.survey_done);
  });

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
      <button class="navbtn" id="nav-transport"><span class="ni">🚗</span><span class="nt"><b>交通 · 司机调配</b><span>${canEdit()?"司机信息库 · 按公司/名字查找":"司机交通调配（同步中）"}</span></span><span class="na">›</span></button>
      ${canEdit()?`<button class="navbtn" id="nav-warehouse"><span class="ni">🗄</span><span class="nt"><b>仓库</b><span>暂时收起的酒店/照片 · 随时捞回来</span></span><span class="na">›</span></button>`:""}
      <div id="map"></div>
      <div class="maplegend">
        <span><i style="background:#7bab95"></i>LIVE</span>
        <span><i style="background:#e08a5d"></i>ENG</span>
        <span><i style="background:#8a7bb0"></i>LIVE+ENG</span>
      </div>
      <div class="filters">${cats.map(c=>`<button class="chip ${c===active?'on':''}" data-c="${esc(c)}">${esc(c)}</button>`).join("")}</div>
      <div class="grid">${canEdit()?`<div class="vcard addcard" id="add-venue-card"><div class="plus">＋</div><div class="lab">添加场馆</div><div class="sub">未踏勘的项目点这里建</div></div>`:""}${list.map(cardHTML).join("")}</div>
      <div class="foot">内部资料 · 仅供 HB 后勤组使用</div>`;
    app.querySelectorAll(".chip").forEach(ch=>ch.onclick=()=>{ active=ch.dataset.c; draw(); });
    app.querySelectorAll(".vcard:not(.addcard)").forEach(el=>el.onclick=()=>location.hash="#/venue/"+el.dataset.id);
    const addc=app.querySelector("#add-venue-card"); if(addc) addc.onclick=openAddVenue;
    const navt=app.querySelector("#nav-transport"); if(navt) navt.onclick=()=>location.hash="#/transport";
    const navw=app.querySelector("#nav-warehouse"); if(navw) navw.onclick=()=>location.hash="#/warehouse";
    drawMap(list);
  }
  function cardHTML(v){
    const slots = v.venue_photos||[]; const tot=slots.length||15;
    const fl = slots.filter(p=>p.storage_path).length;
    // 封面统一用「场馆外观」，没有则回退到其它已填照片
    const cover = slots.find(p=>p.slot_key==="venue_exterior"&&p.storage_path) || slots.find(p=>p.storage_path);
    const coverUrl = cover? pubUrl(cover.storage_path) : null;
    const pct = Math.round(fl/tot*100);
    return `<div class="vcard" data-id="${v.id}">
      <div class="thumb" style="${coverUrl?`background-image:url('${coverUrl}')`:''}">
        ${v.c_code?`<span class="code">${esc(v.c_code)}</span>`:""}
        <span class="ttype ${v.team_type||'LIVE'}">${ttLabel(v.team_type)}</span>
        ${fl===0?`<span class="pending">🕓 待踏勘</span>`:""}
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
        const color = TTCOLOR[v.team_type] || TTCOLOR.LIVE;
        L.circleMarker([v.lat,v.lng],{radius:9,fillColor:color,color:"#fff",weight:2.5,fillOpacity:1}).addTo(homeMap)
          .bindPopup(`<b>${esc(v.c_code)} ${esc(v.category||"")}</b><br>${esc(v.venue_name_jp||"")} · ${ttLabel(v.team_type)}`);
        marks.push([v.lat,v.lng]);
      });
      if(marks.length) homeMap.fitBounds(marks,{padding:[40,40],maxZoom:13});
    },60);
  }
  draw();
}

/* ---------------- 交通 · 司机信息库 ---------------- */
let DRIVERS=[];
async function renderTransport(){
  if(!canEdit()){
    app.innerHTML=`<div class="detail-hero"><span class="code">交通</span><h2>司机交通调配</h2><div class="jp">同步中…</div></div>
      <div class="section"><div class="loading">🚗 司机交通调配正在同步中<br><br><span style="font-size:13px">稍后开放查看</span></div></div>`;
    return;
  }
  app.innerHTML=`<div class="loading">加载司机库…</div>`;
  const {data}=await sb.from("drivers").select("*").order("sort_order");
  DRIVERS=data||[];
  const companies=[...new Set(DRIVERS.map(d=>d.company||"未分组"))];
  app.innerHTML=`
    <div class="detail-hero"><span class="code">交通</span><h2>司机信息库</h2>
      <div class="jp">${DRIVERS.length} 名司机 · ${companies.length} 家公司 · 滚动按公司浏览 / 上方搜名字</div></div>
    <div class="section">
      <input id="drv-search" class="drv-search" type="search" placeholder="🔍 输入名字搜（中文/日文/拼音都行）">
      <div id="drv-list"></div>
    </div>
    <div class="foot">交通模块 · 司机调配（持续完善）</div>`;
  const listEl=app.querySelector("#drv-list");
  const draw=(kw)=>{
    kw=(kw||"").trim().toLowerCase();
    const match=d=>!kw||[d.family_name,d.given_name,d.jp_name,d.phone,d.team,d.plate].some(x=>(x||"").toLowerCase().includes(kw));
    listEl.innerHTML=companies.map(co=>{
      const ds=DRIVERS.filter(d=>(d.company||"未分组")===co && match(d));
      if(!ds.length) return "";
      return `<div class="drv-co">🏢 ${esc(co)}<span class="count">${ds.length} 人</span></div>
        <div class="drv-grid">${ds.map(driverCardHTML).join("")}</div>`;
    }).join("")||`<div class="muted-empty">没找到「${esc(kw)}」</div>`;
    listEl.querySelectorAll(".drv-card").forEach(el=>el.onclick=()=>openDriver(el.dataset.id));
  };
  draw("");
  app.querySelector("#drv-search").addEventListener("input",e=>draw(e.target.value));
}
function driverCardHTML(d){
  const nm=esc((d.jp_name||"")||((d.family_name||"")+" "+(d.given_name||"")));
  const roma=esc(((d.family_name||"")+" "+(d.given_name||"")).trim());
  const img=d.photo_path?pubUrl(d.photo_path):null;
  return `<div class="drv-card" data-id="${d.id}">
    <div class="drv-photo">${img?`<img loading="lazy" src="${img}" alt="">`:`<span class="drv-noimg">无照片</span>`}</div>
    <div class="drv-info"><div class="drv-name">${nm}</div>
      <div class="drv-sub">${roma}</div>
      ${d.phone?`<div class="drv-tel">📞 ${esc(d.phone)}</div>`:""}
      ${d.plate?`<div class="drv-sub">🚗 ${esc(d.plate)}</div>`:""}${d.team?`<div class="drv-sub">👥 ${esc(d.team)}</div>`:""}
    </div></div>`;
}
function openDriver(id){
  const d=DRIVERS.find(x=>x.id===id); if(!d) return;
  const img=d.photo_path?pubUrl(d.photo_path):null;
  const row=(k,v)=>v?`<div class="hmeta"><span class="lab">${k}</span><span>${esc(v)}</span></div>`:"";
  const ov=document.createElement("div"); ov.className="drvmodal";
  ov.innerHTML=`<div class="nbox">
    <div class="ntitle">${esc((d.jp_name||"")+"  "+((d.family_name||"")+" "+(d.given_name||"")))}</div>
    ${img?`<img src="${img}" alt="" style="width:120px;height:150px;object-fit:cover;border-radius:12px;margin:0 auto 12px;display:block;border:1px solid var(--line)">`:""}
    ${row("公司",d.company)}${row("电话",d.phone)}${row("邮箱",d.email)}${row("出生日期",d.dob)}${row("性别",d.gender)}${row("国籍",d.nationality)}
    ${row("证件类型",d.id_type)}${row("证件号",d.id_number)}${row("护照到期",d.passport_expiry)}
    ${row("所属团队",d.team)}${row("负责任务",d.task)}${row("车牌号",d.plate)}
    <div class="nacts"><button class="btn ghost" id="drv-close">关闭</button><button class="btn" id="drv-edit">编辑运营信息</button></div>
  </div>`;
  document.body.appendChild(ov); ov.classList.add("on");
  const close=()=>ov.remove();
  ov.addEventListener("click",e=>{ if(e.target===ov) close(); });
  ov.querySelector("#drv-close").onclick=close;
  ov.querySelector("#drv-edit").onclick=()=>{ close(); openDriverEdit(d); };
}
function openDriverEdit(d){
  const team=prompt("所属团队（如 C23 排球A）：", d.team||""); if(team===null) return;
  const task=prompt("负责任务（如 接送运动员/物资）：", d.task||""); if(task===null) return;
  const plate=prompt("车牌号：", d.plate||""); if(plate===null) return;
  sb.from("drivers").update({team:team.trim()||null,task:task.trim()||null,plate:plate.trim()||null}).eq("id",d.id)
    .then(({error})=>{ if(error){toast("保存失败");return;} toast("已保存 ✓"); renderTransport(); });
}

/* ---------------- 仓库（软删除存放处，可捞回来）---------------- */
async function renderWarehouse(){
  if(!canEdit()){ location.hash="#/"; return; }
  app.innerHTML=`<div class="loading">加载仓库…</div>`;
  const [{data:hotels},{data:exphotos},{data:vs}]=await Promise.all([
    sb.from("venue_hotels").select("*").not("archived_at","is",null).order("archived_at",{ascending:false}),
    sb.from("extra_photos").select("*").not("archived_at","is",null).order("archived_at",{ascending:false}),
    sb.from("venues").select("id,c_code,category"),
  ]);
  const vsorted=(vs||[]).slice().sort((a,b)=>((a.c_code||"zz")+"").localeCompare((b.c_code||"zz")+""));
  const vmap={}; vsorted.forEach(v=>vmap[v.id]=((v.c_code?v.c_code+" ":"")+(v.category||"")).trim()||"未命名场馆");
  const vopts=(sel)=>vsorted.map(v=>`<option value="${v.id}"${v.id===sel?" selected":""}>${esc(vmap[v.id])}</option>`).join("");
  const empty=(!hotels||!hotels.length)&&(!exphotos||!exphotos.length);
  app.innerHTML=`
    <div class="wh-intro">📦 暂时收起来的酒店和照片都在这里。<b>不会真删</b>。捞酒店时可以<b>选捞到哪个场馆</b>（连照片一起搬过去），照片默认回原场馆。</div>
    ${empty?`<div class="muted-empty" style="margin-top:24px">仓库是空的 ✨ —— 没有被收起来的东西</div>`:""}
    ${(hotels&&hotels.length)?`<div class="section"><h3><span class="dot dh"></span>🏨 收起来的酒店<span class="count">${hotels.length} 家</span></h3>
      ${hotels.map(h=>`<div class="wh-row">
        <div class="wh-info"><div class="wh-name">${esc(h.name||"未命名酒店")}</div><div class="wh-meta">原属：${esc(vmap[h.venue_id]||"—")}${h.address?` · ${esc(h.address)}`:""}</div></div>
        <div class="wh-ctrl">
          <label class="wh-ctrl-lab">捞到 →</label>
          <select class="wh-target" data-id="${h.id}">${vopts(h.venue_id)}</select>
          <button class="btn-sm wh-restore" data-kind="hotel" data-id="${h.id}">♻️ 捞回来</button>
        </div>
      </div>`).join("")}</div>`:""}
    ${(exphotos&&exphotos.length)?`<div class="section"><h3><span class="dot"></span>📷 收起来的补充照片<span class="count">${exphotos.length} 张</span></h3>
      <div class="wh-photos">${exphotos.map(e=>`<div class="wh-photo">
        <img src="${pubUrl(e.storage_path)}" alt="" loading="lazy">
        <div class="wh-photo-meta">${esc(e.note||"补充照片")}<br><span class="muted">${esc(vmap[e.venue_id]||"—")}</span></div>
        <button class="btn-sm wh-restore" data-kind="extra" data-id="${e.id}">♻️ 捞回原场馆</button>
      </div>`).join("")}</div></div>`:""}
  `;
  app.querySelectorAll(".wh-restore").forEach(btn=>{
    btn.onclick=async()=>{
      btn.disabled=true;
      if(btn.dataset.kind==="hotel"){
        const hid=btn.dataset.id;
        const h=(hotels||[]).find(x=>x.id===hid);
        const target=app.querySelector(`.wh-target[data-id="${hid}"]`)?.value || h.venue_id;
        const upd={archived_at:null}; if(target) upd.venue_id=target;
        const {error}=await sb.from("venue_hotels").update(upd).eq("id",hid);
        if(error){ toast("捞回失败"); btn.disabled=false; return; }
        if(target && target!==h.venue_id){   // 捞到别的场馆=连照片+笔记一起搬
          await sb.from("venue_photos").update({venue_id:target}).eq("hotel_id",hid);
          await sb.from("section_notes").update({venue_id:target}).eq("hotel_id",hid);
          await logAct(target,"从仓库捞入酒店",h.name||"酒店");
        }
        toast("已捞到 "+(vmap[target]||"场馆")+" ✓");
      } else {
        const {error}=await sb.from("extra_photos").update({archived_at:null}).eq("id",btn.dataset.id);
        if(error){ toast("捞回失败"); btn.disabled=false; return; }
        toast("已捞回 ✓");
      }
      renderWarehouse();
    };
  });
}

/* ---------------- 详情页 ---------------- */
const GROUP_ORDER = ["概览","场馆","酒店"];
async function renderDetail(id){
  const _startY = _freshNav ? 0 : window.scrollY; _freshNav=false;   // D1：编辑后重渲染保留位置
  app.innerHTML = `<div class="loading">加载场馆资料…</div>`;
  const [{data:v},{data:photos},{data:hotels},{data:events},{data:logs},{data:extras},{data:acts}] = await Promise.all([
    sb.from("venues").select("*").eq("id",id).single(),
    sb.from("venue_photos").select("*").eq("venue_id",id).order("sort_order"),
    sb.from("venue_hotels").select("*").eq("venue_id",id).is("archived_at",null).order("sort_order"),
    sb.from("venue_events").select("*").eq("venue_id",id).order("sort_order"),
    sb.from("survey_logs").select("*").eq("venue_id",id).order("created_at",{ascending:false}),
    sb.from("extra_photos").select("*").eq("venue_id",id).is("archived_at",null).order("created_at"),
    sb.from("activity_log").select("*").eq("venue_id",id).order("created_at",{ascending:false}).limit(40),
  ]);
  if(!v){ app.innerHTML=`<div class="loading">场馆不存在</div>`; return; }
  // 我的笔记（编辑专属：只读不拉取、不渲染）
  let snotes=[];
  if(canEdit()){ const {data:sn}=await sb.from("section_notes").select("*").eq("venue_id",id); snotes=sn||[]; }
  SNOTES=snotes; CURV=v;

  const groups={};
  (photos||[]).forEach(p=>{ (groups[p.slot_group]=groups[p.slot_group]||[]).push(p); });
  const filled=(photos||[]).filter(p=>p.storage_path).length;
  const total=photos?.length||0;
  const pct = total ? Math.round(filled/total*100) : 0;
  VENUE_DONE = !!v.survey_done;
  // 只读用户不能直接看未公开（未踏勘）的场馆
  if(!canEdit() && !viewerCanSee(filled, v.survey_done)){
    app.innerHTML=`<div class="loading">🔒 该场馆还在踏勘中，暂未公开<br><br><span style="font-size:13px">踏勘完成后即可查看</span></div>`; return;
  }

  app.innerHTML = `
    <div class="detail-hero">
      ${canEdit()?`<button class="hero-edit" id="hero-edit">编辑</button>`:""}
      <span class="code">${esc(v.c_code||"")}</span><span class="ttype ${v.team_type||'LIVE'}">${ttLabel(v.team_type)}</span>
      <h2>${esc(v.category||"")}</h2>
      <div class="jp">${esc(v.venue_name_jp||"")}</div>
      <div class="kv">
        <div><div class="k">执行团队</div><div class="v">${esc(v.team||"—")}</div></div>
        <div><div class="k">实测车程</div><div class="v">${esc(v.travel_time||"待测")}</div></div>
        <div><div class="k">工作区间</div><div class="v">${fmtPeriod(v)}</div></div>
        <div><div class="k">团队人数</div><div class="v">${esc(v.team_size||"—")}</div></div>
      </div>
    </div>

    <div class="section idcard">
      <h3><span class="dot"></span>识别信息 · 比赛项目<span class="count">${esc(v.c_code||"")} · ${ttLabel(v.team_type)}</span></h3>
      ${(events&&events.length)? events.map(e=>`<div class="evrow">
        <span class="en">${esc(v.c_code||"")} · ${esc(e.name||"")}${e.name_en?` / ${esc(e.name_en)}`:""}${e.note?` / ${esc(e.note)}`:""}</span>
        <span class="es">${esc(e.schedule||"")}</span>
      </div>`).join("") : `<div class="muted-empty">暂无比赛项目</div>`}
      <div class="idtags">
        <span class="idlab">识别标注</span>
        <span class="idval">${v.labels?esc(v.labels):`<span class="muted">${canEdit()?"（可填三字母缩写码等任意标注）":"—"}</span>`}</span>
        ${canEdit()?`<button class="sec-edit2" id="labels-edit">编辑</button>`:""}
      </div>
    </div>

    ${(()=>{ const ov=(photos||[]).filter(p=>p.slot_group==='概览'&&!p.hotel_id);
      const hasGeo=(v.lat&&v.lng) || (hotels||[]).some(h=>h.lat&&h.lng);
      return (ov.length||canEdit()||hasGeo)?`<div class="section">
      <h3><span class="dot"></span>概览<span class="count">全队总览 · 点开放大</span></h3>
      ${hasGeo?`<div class="hint-line">📍 本场馆 + 酒店位置（红=场馆 蓝=酒店）</div><div id="ovmap" class="detmap"></div>`:(canEdit()?`<div class="hint-line muted">📍 位置地图：本馆/酒店还没有坐标，补全地址坐标后自动显示</div>`:"")}
      <div class="hint-line" style="margin-top:10px">住宿信息表 / 餐饮信息统计表（全队的大表放这里）</div>
      <div class="slots docs">${ov.map(p=>docSlotHTML(p,false)).join("")}</div>
      ${myNoteHTML('overview',null)}
    </div>`:""; })()}

    <div class="section module module-venue">
      <h3><span class="dot venue"></span>🏟 场馆<span class="count">${(photos||[]).filter(p=>p.slot_group==='场馆'&&!p.hotel_id&&p.storage_path).length}/${(photos||[]).filter(p=>p.slot_group==='场馆'&&!p.hotel_id).length} 已填</span>${canEdit()?`<button class="sec-edit" id="venue-edit">编辑信息</button>`:""}</h3>
      <div class="hotel" style="margin-top:0;margin-bottom:10px">
        <div class="hmeta"><span class="lab">场馆</span><span>${esc(v.venue_name_jp||"")}</span></div>
        <div class="hmeta"><span class="lab">地址</span><span>${esc(v.venue_address||"—")}</span></div>
        <div class="hmeta"><span class="lab">最近交通</span><span>${esc(v.nearest_transit||"—")}</span></div>
        <div class="hmeta"><span class="lab">停车</span><span>${esc(v.parking_note||"—")}</span></div>
      </div>
      ${v.venue_intro?`<div class="intro-box" style="margin-bottom:10px">${esc(fmtIntro(v.venue_intro))}</div>`:""}
      <div class="slots">${(photos||[]).filter(p=>p.slot_group==='场馆'&&!p.hotel_id).map(slotHTML).join("")}${(()=>{ const base=(photos||[]).filter(p=>p.slot_group==='场馆'&&!p.hotel_id&&/场馆周边/.test(p.slot_label||"")).length; return (extras||[]).map((e,i)=>extraHTML(e, base+1+i)).join(""); })()}${canEdit()?`<div class="slot add" id="add-extra"><div class="ico">＋</div><div class="lab">加照片</div></div>`:""}</div>
      ${tipsCardHTML(v.public_tips, `tips-venue`)}
      ${canEdit()?internalCardHTML(v.internal_note, `int-venue`):""}
      ${myNoteHTML('venue',null)}
    </div>

    <div class="section">
      <h3><span class="dot dh"></span>🏨 酒店<span class="count">${hotels?.length||0} 家</span>${canEdit()?`<button class="sec-edit" id="add-hotel">＋添加酒店</button>`:""}</h3>
      ${(hotels&&hotels.length)? hotels.map(h=>hotelModuleHTML(h, photos, id)).join("") : `<div class="muted-empty">${canEdit()?"还没有酒店，点「＋添加酒店」录入":"暂无"}</div>`}
    </div>

    ${canEdit()?`<div class="section">
      <h3><span class="dot"></span>踏勘说明<span class="count">仅编辑可见 · ${logs?.length||0} 条</span></h3>
      <div id="logs">${(logs&&logs.length)? logs.map(logHTML).join("") : `<div class="muted-empty">还没有记录，第一条由你来写 👇</div>`}</div>
      <div class="logform">
        <textarea id="log-txt" placeholder="补充这个场馆的踏勘情况，比如停车、动线、注意事项…"></textarea>
        <button class="btn" id="log-add">＋ 添加记录</button>
      </div>
    </div>`:""}

    ${canEdit()?`<div class="section exportbox">
      <button class="btn export-pack" id="export-pack">📦 导出图片包（${esc(v.c_code||"")} ${esc(v.category||"")}）</button>
      <div class="hint-line" style="text-align:center;margin-top:8px">把本场馆所有照片按名字打包成 zip 下载（手册版 PPTX 请跟管理员说一声）</div>
    </div>`:""}
    ${canEdit()?`<div class="done-row done-foot">${v.survey_done
      ? `<span class="done-badge">✓ 踏勘已完成</span>`
      : `<button class="done-btn" id="survey-done">踏勘完成</button>`}</div>`:""}
    <div class="foot">${esc(v.c_code)} · 资料随踏勘持续更新</div>`;

  // 概览坐标地图（本馆+它的酒店；有坐标才渲染）
  if(app.querySelector("#ovmap")){
    setTimeout(()=>{
      const center=[v.lat||35.18, v.lng||136.91];
      const m=L.map("ovmap",{scrollWheelZoom:false,zoomControl:false}).setView(center,13);
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",{maxZoom:18}).addTo(m);
      const red=L.divIcon({className:"",html:`<div style="width:16px;height:16px;border-radius:50%;background:#d9534f;border:2.5px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.35)"></div>`,iconSize:[16,16],iconAnchor:[8,8]});
      const blue=L.divIcon({className:"",html:`<div style="width:16px;height:16px;border-radius:50%;background:#4a73c4;border:2.5px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.35)"></div>`,iconSize:[16,16],iconAnchor:[8,8]});
      const pts=[];
      if(v.lat&&v.lng){ L.marker([v.lat,v.lng],{icon:red}).addTo(m).bindPopup("🏟 场馆："+esc(v.venue_name_jp||v.category||"")); pts.push([v.lat,v.lng]); }
      (hotels||[]).forEach(h=>{ if(h.lat&&h.lng){ L.marker([h.lat,h.lng],{icon:blue}).addTo(m).bindPopup("🏨 酒店："+esc(h.name||"")); pts.push([h.lat,h.lng]); } });
      if(pts.length>1) m.fitBounds(pts,{padding:[34,34],maxZoom:15});
      else if(pts.length===1) m.setView(pts[0],14);
      setTimeout(()=>m.invalidateSize(),250);
    },60);
  }

  // 踏勘完成（底部小按钮：标记完成 + 出小章鱼；不再控制对外可见）
  const doneBtn=app.querySelector("#survey-done");
  if(doneBtn) doneBtn.onclick=async()=>{
    if(!confirm("确认这个场馆踏勘完成了吗？")) return;
    const {error}=await sb.from("venues").update({survey_done:true}).eq("id",id);
    if(error){ toast("保存失败"); return; }
    await logAct(id,"标记踏勘完成",null);
    VENUE_DONE=true; thankYou(); renderDetail(id);
  };

  // 固定坑位（含概览大图）
  app.querySelectorAll(".slot[data-pid], .docslot[data-pid]").forEach(el=>{
    const get=()=>(photos||[]).find(x=>x.id===el.dataset.pid);
    if(canEdit()) enableSlotDrop(el, get);   // 电脑端拖拽上传/替换
    if(!get().storage_path){ // 空坑位
      if(canEdit()) el.onclick=()=>pickAndUpload(get(), el, id);
      return;
    }
    bindPhoto(el,
      ()=>openLightbox({kind:"slot",rec:get(),venueId:id}),
      ()=>openNote({kind:"slot",rec:get(),venueId:id}));
  });
  // 顶部概览编辑（绿色区，仅编辑）
  const hEdit=app.querySelector("#hero-edit");
  if(hEdit) hEdit.onclick=()=>openHeroEditor(v);
  // 基本信息编辑（白色区，仅编辑）
  const vEdit=app.querySelector("#venue-edit");
  if(vEdit) vEdit.onclick=()=>openVenueEditor(v);
  // 识别标注编辑（仅编辑）
  const lEdit=app.querySelector("#labels-edit");
  if(lEdit) lEdit.onclick=()=>openTextEditor("识别标注（如三字母缩写码、任意标记）", v.labels||"", async(val)=>{
    const {error}=await sb.from("venues").update({labels:val||null}).eq("id",id);
    if(error){ toast("保存失败"); return; }
    await logAct(id,"编辑识别标注",val||null); toast("已保存"); maybeThank(); renderDetail(id);
  });
  // 场馆 内部提示 / 公开TIPs
  const intV=app.querySelector("#int-venue");
  if(intV) intV.onclick=()=>openTextEditor("场馆内部提示（仅编辑可见）", v.internal_note||"", async(val)=>{
    const {error}=await sb.from("venues").update({internal_note:val||null}).eq("id",id);
    if(error){ toast("保存失败"); return; }
    await logAct(id,"编辑场馆内部提示",null); toast("已保存"); maybeThank(); renderDetail(id);
  });
  const tipV=app.querySelector("#tips-venue");
  if(tipV) tipV.onclick=()=>openTextEditor("场馆重要提示（场馆经理可见）", v.public_tips||"", async(val)=>{
    const {error}=await sb.from("venues").update({public_tips:val||null}).eq("id",id);
    if(error){ toast("保存失败"); return; }
    await logAct(id,"编辑场馆重要提示",null); toast("已保存"); maybeThank(); renderDetail(id);
  });
  // 各酒店 内部提示 / 公开TIPs
  (hotels||[]).forEach(h=>{
    const bi=app.querySelector(`#int-h-${CSS.escape(h.id)}`);
    if(bi) bi.onclick=()=>openTextEditor(`内部提示 · ${h.name||""}`, h.internal_note||"", async(val)=>{
      const {error}=await sb.from("venue_hotels").update({internal_note:val||null}).eq("id",h.id);
      if(error){ toast("保存失败"); return; }
      await logAct(id,"编辑酒店内部提示",h.name); toast("已保存"); maybeThank(); renderDetail(id);
    });
    const bt=app.querySelector(`#tips-h-${CSS.escape(h.id)}`);
    if(bt) bt.onclick=()=>openTextEditor(`重要提示 · ${h.name||""}`, h.public_tips||"", async(val)=>{
      const {error}=await sb.from("venue_hotels").update({public_tips:val||null}).eq("id",h.id);
      if(error){ toast("保存失败"); return; }
      await logAct(id,"编辑酒店重要提示",h.name); toast("已保存"); maybeThank(); renderDetail(id);
    });
  });
  // 我的笔记 保存（编辑专属）
  app.querySelectorAll(".mynote-save").forEach(btn=>{
    btn.onclick=async()=>{
      const key=btn.dataset.key, hid=btn.dataset.hid||null;
      const ta=btn.closest(".mynote").querySelector(".mynote-ta");
      const val=ta.value.trim();
      const existing=SNOTES.find(n=>n.section_key===key && (n.hotel_id||null)===hid);
      let error;
      if(existing){ ({error}=await sb.from("section_notes").update({note:val||null,updated_by:whoami(),updated_at:new Date().toISOString()}).eq("id",existing.id)); }
      else { ({error}=await sb.from("section_notes").insert({venue_id:id,hotel_id:hid,section_key:key,note:val||null,updated_by:whoami()})); }
      if(error){ toast("保存失败"); return; }
      toast("笔记已保存 ✓"); renderDetail(id);
    };
  });
  // 概览/补充资料 坑位改名
  app.querySelectorAll(".docrename").forEach(btn=>{
    btn.onclick=async(e)=>{ e.stopPropagation();
      const p=(photos||[]).find(x=>x.id===btn.dataset.pid); if(!p) return;
      const name=(prompt("给这个格子起/改个名字：", p.slot_label||"")||"").trim();
      if(!name || name===p.slot_label) return;
      const {error}=await sb.from("venue_photos").update({slot_label:name}).eq("id",p.id);
      if(error){ toast("改名失败"); return; }
      await logAct(id,"重命名格子",name); toast("已改名 ✓"); renderDetail(id);
    };
  });
  // 添加 概览/补充资料 坑位
  app.querySelectorAll(".addslot").forEach(el=>{
    el.onclick=async()=>{
      const scope=el.dataset.scope, hid=el.dataset.hid||null;
      const def = scope==='overview'?"概览大表（路线/住宿表/餐饮表）": scope==='more'?"补充资料（路线/餐饮/住宿等）":"资料";
      const name=(prompt(`给这份「${def}」起个名字（如"知立酒店路线"）：`, "")||"").trim();
      if(!name) return;
      const key=`${scope==='overview'?'ov':'more'}_${Math.random().toString(36).slice(2,8)}`;
      const grp = scope==='overview'?'概览':'酒店';
      const {error}=await sb.from("venue_photos").insert({venue_id:id,hotel_id:hid,slot_key:key,slot_group:grp,slot_label:name,slot_type:"paste",storage_path:null,sort_order:50});
      if(error){ toast("添加失败"); return; }
      await logAct(id,"添加坑位",name); toast("已添加，点它上传图"); renderDetail(id);
    };
  });
  // 酒店编辑（仅编辑）
  app.querySelectorAll(".hedit").forEach(btn=>{
    btn.onclick=(e)=>{ e.stopPropagation(); const h=(hotels||[]).find(x=>x.id===btn.dataset.hid); if(h) openHotelEditor(h, id); };
  });
  const addHotelBtn=app.querySelector("#add-hotel");
  if(addHotelBtn) addHotelBtn.onclick=()=>openAddHotel(id);
  // 酒店 迁移 / 删除
  app.querySelectorAll(".hmig").forEach(btn=>{
    btn.onclick=(e)=>{ e.stopPropagation(); const h=(hotels||[]).find(x=>x.id===btn.dataset.hid); if(h) openMigrate("hotel",h,id); };
  });
  app.querySelectorAll(".hdel").forEach(btn=>{
    btn.onclick=async(e)=>{ e.stopPropagation(); const h=(hotels||[]).find(x=>x.id===btn.dataset.hid); if(!h) return;
      if(!confirm(`把酒店「${h.name||""}」收进仓库？（连同照片暂时收起，需要时能从仓库捞回来，不会真删）`)) return;
      await sb.from("venue_hotels").update({archived_at:new Date().toISOString()}).eq("id",h.id);
      await logAct(id,"收进仓库·酒店",h.name); toast("已收进仓库 📦"); maybeThank(); renderDetail(id); };
  });
  // 「酒店到场馆路线」空坑：点一下建坑位，再点它上传路线图
  app.querySelectorAll(".addroute").forEach(el=>{
    el.onclick=async()=>{
      const hid=el.dataset.hid;
      const {error}=await sb.from("venue_photos").insert({venue_id:id,hotel_id:hid,slot_key:"hotel_route",slot_group:"酒店",slot_label:"酒店到场馆路线",slot_type:"paste",storage_path:null,sort_order:9});
      if(error){ toast("添加失败"); return; }
      await logAct(id,"添加酒店路线坑位",null); toast("坑位已建，点它上传路线图"); renderDetail(id);
    };
  });
  // 补充照片
  app.querySelectorAll(".slot[data-eid]").forEach(el=>{
    const get=()=>(extras||[]).find(x=>x.id===el.dataset.eid);
    bindPhoto(el,
      ()=>openLightbox({kind:"extra",rec:get(),venueId:id}),
      ()=>openNote({kind:"extra",rec:get(),venueId:id}));
  });
  const addEl=app.querySelector("#add-extra");
  if(addEl && canEdit()){
    addEl.onclick=()=>addExtraPhoto(id, addEl);
    addEl.addEventListener("dragover",e=>{ e.preventDefault(); addEl.classList.add("dragover"); });
    addEl.addEventListener("dragleave",()=>addEl.classList.remove("dragover"));
    addEl.addEventListener("drop",e=>{ e.preventDefault(); addEl.classList.remove("dragover");
      const f=e.dataTransfer.files&&e.dataTransfer.files[0]; if(f) doExtraUpload(f, id, addEl); });
  }
  // 踏勘说明（仅编辑权限可添加）
  const logAdd=app.querySelector("#log-add");
  if(logAdd) logAdd.onclick=async()=>{
    const txt=app.querySelector("#log-txt").value.trim();
    if(!txt){ toast("写点内容再添加"); return; }
    const author=whoami();
    const {error}=await sb.from("survey_logs").insert({venue_id:id,author,content:txt});
    if(error){ toast("保存失败"); return; }
    await logAct(id, "写了踏勘说明", null);
    toast("已添加"); maybeThank(); renderDetail(id);
  };
  // 导出图片包（浏览器内打包,免费自助）
  const expBtn=app.querySelector("#export-pack");
  if(expBtn) expBtn.onclick=()=>exportImagePack(v, hotels||[], photos||[], extras||[], expBtn);

  // D1：编辑后重渲染，滚回刚才的位置（首次进入 _startY=0 回顶部）
  if(_startY){ requestAnimationFrame(()=>window.scrollTo(0,_startY)); setTimeout(()=>window.scrollTo(0,_startY),160); }
}

// 文件名安全化
function fnSafe(s){ s=(s||"").toString().trim()||"未命名"; return s.replace(/[\/\\:*?"<>|\n\t]/g,"_").slice(0,60); }
// 浏览器内把本场馆所有照片按名字打包成 zip 下载
async function exportImagePack(v, hotels, photos, extras, btn){
  if(!window.JSZip){ toast("打包组件未加载，刷新重试"); return; }
  const old=btn.textContent; btn.disabled=true; btn.textContent="打包中…请稍候";
  try{
    const zip=new JSZip();
    const root=`${v.c_code||""}_${fnSafe(v.category)}_图片`;
    const hidx={}, hname={};
    hotels.forEach((h,i)=>{ hidx[h.id]=i+1; hname[h.id]=fnSafe(h.name||("酒店"+(i+1))); });
    const used={};
    const add=async(storage_path, name, sub)=>{
      const blob=await fetch(pubUrl(storage_path)).then(r=>r.ok?r.blob():null);
      if(!blob) return;
      const base=fnSafe(name); const key=sub+"/"+base; used[key]=(used[key]||0)+1;
      const fn=used[key]===1?base:`${base}_${used[key]}`;
      zip.file(`${root}/${sub}/${fn}.jpg`, blob);
    };
    for(const p of photos.filter(x=>x.storage_path)){
      const sub = p.hotel_id ? `酒店${hidx[p.hotel_id]||""}_${hname[p.hotel_id]||""}`
                : p.slot_group==="概览"?"概览": p.slot_group==="场馆"?"场馆":"其它";
      await add(p.storage_path, p.note||p.slot_label, sub);
    }
    for(const e of extras.filter(x=>x.storage_path)){
      await add(e.storage_path, e.note||e.caption||"补充照片", "补充照片");
    }
    const content=await zip.generateAsync({type:"blob"});
    const a=document.createElement("a");
    a.href=URL.createObjectURL(content);
    a.download=`${v.c_code||"场馆"}_${fnSafe(v.category)}_图片包.zip`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(()=>URL.revokeObjectURL(a.href), 4000);
    toast("图片包已生成 ✓");
  }catch(err){ console.error(err); toast("打包失败："+(err.message||err)); }
  finally{ btn.disabled=false; btn.textContent=old; }
}

function fmtPeriod(v){
  if(!v.work_start) return v.work_days? v.work_days+"天":"—";
  const f=d=>{ if(!d) return ""; const [y,mo,da]=d.split("-"); return `${+mo}/${+da}`; };
  return `${f(v.work_start)}–${f(v.work_end)}${v.work_days?` (${v.work_days}天)`:""}`;
}
function slotHTML(p){
  if(p.storage_path){
    let note=(canEdit()||p.note_public!==false) ? (p.note||"").trim() : "";
    if(note===(p.slot_label||"").trim()) note="";   // 备注与标题相同就不重复显示(C2)
    const strip = note ? `<span class="cap note">${esc(note)}</span>` : (p.caption?`<span class="cap">${esc(p.caption)}</span>`:"");
    return `<div class="slot filled${note?" hasnote":""}" data-pid="${p.id}"${note?` title="${esc(note)}"`:""}>
      <img loading="lazy" src="${pubUrl(p.storage_path,p.updated_at)}" alt="${esc(p.slot_label)}">
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
// 圈数字 ①..⑳，超出用普通数字
function circled(n){ const C="①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳"; return (n>=1&&n<=20)?C[n-1]:String(n); }
function extraHTML(e, num){
  let note=(canEdit()||e.note_public!==false) ? (e.note||e.caption||"").trim() : ""; // 只读看私密备注=隐藏
  const label="场馆周边"+circled(num);                 // 标题=场馆周边+序号(接固定坑①②③往后排)
  if(note===label || note==="补充照片") note="";        // 与标题相同/默认占位就不重复
  const strip = note ? `<span class="cap note">${esc(note)}</span>` : "";  // 描述=金色
  return `<div class="slot filled${note?" hasnote":""}" data-eid="${e.id}"${note?` title="${esc(note)}"`:""}>
    <img loading="lazy" src="${pubUrl(e.storage_path,e.created_at)}" alt="${esc(label)}">
    <div class="caption"><span class="lab">${esc(label)}</span>${strip}</div>
  </div>`;
}
function docSlotHTML(p, showRename=true){
  const ren = (canEdit()&&showRename)?`<button class="docrename" data-pid="${p.id}">✏️改名</button>`:"";
  if(p.storage_path){
    let note=(p.note||"").trim();
    if(note===(p.slot_label||"").trim()) note="";   // 与标题相同不重复(C2)
    const sub = note ? note : (p.caption||"");
    return `<div class="docslot${note?" hasnote":""}" data-pid="${p.id}"${note?` title="${esc(note)}"`:""}>
      ${ren}
      <img loading="lazy" src="${pubUrl(p.storage_path,p.updated_at)}" alt="${esc(p.slot_label)}">
      <span class="dzoom">🔍 点开放大</span>
      <div class="dlabel">${esc(p.slot_label)}${sub?` · ${esc(sub)}`:""}</div>
    </div>`;
  }
  if(!canEdit()) return `<div class="docslot empty"><div class="ico">🖼️</div><div class="lab">${esc(p.slot_label)} · 暂无</div></div>`;
  return `<div class="docslot empty" data-pid="${p.id}">${ren}<div class="ico">${p.slot_type==="paste"?"🖼️":"📷"}</div><div class="lab">${esc(p.slot_label)} · 点击上传</div></div>`;
}
const HMAIN=["hotel_exterior","hotel_map","hotel_lobby","hotel_surround_1","hotel_surround_2","hotel_surround_3"];
const SUBCATS=[["route","🗺 路线"],["dining","🍱 餐饮"],["lodging","🛏 住宿"]];
function tipsCardHTML(text, editId){
  if(!text && !canEdit()) return "";
  return `<div class="tips-card">
    <div class="tips-hd"><span>⭐ 重要提示</span>${canEdit()?`<button class="iedit" id="${editId}">编辑</button>`:""}</div>
    ${text?`<div class="tips-body">${esc(text)}</div>`:`<div class="iempty">还没有重要提示，点「编辑」添加场馆经理需要知道的运营要点</div>`}
  </div>`;
}
function internalCardHTML(text, editId){
  return `<div class="intnote">
    <div class="ihd">🔒 内部提示 · 只读看不到<button class="iedit" id="${editId}">编辑</button></div>
    ${text?`<div class="ibody">${esc(text)}</div>`:`<div class="iempty">还没有内部提示（订餐电话、价格、提前预约天数、店长联系方式等）</div>`}
  </div>`;
}
function myNoteHTML(key, hid){
  if(!canEdit()) return "";
  const rec=SNOTES.find(n=>n.section_key===key && (n.hotel_id||null)===(hid||null));
  const txt=rec?.note||"";
  const meta=rec&&rec.updated_at?`改于 ${new Date(rec.updated_at).toLocaleDateString()}`:"";
  return `<details class="mynote"${txt?" open":""}>
    <summary>📝 我的笔记（仅编辑可见）${txt?" · 已记":""}</summary>
    <textarea class="mynote-ta" placeholder="随手记，只有编辑能看到…">${esc(txt)}</textarea>
    <div class="mynote-row"><span class="mynote-meta">${meta}</span><button class="btn-sm mynote-save" data-key="${key}" data-hid="${hid||""}">保存笔记</button></div>
  </details>`;
}
function addSlotBtnHTML(vid, hid, scope, label){
  return `<div class="docslot empty addslot" data-scope="${scope}" data-hid="${hid||""}"><div class="ico">＋</div><div class="lab">${label||"添加一套"}</div></div>`;
}
function hotelModuleHTML(h, photos, vid){
  const hp=(photos||[]).filter(p=>p.hotel_id===h.id);
  const main=HMAIN.map(k=>hp.find(p=>p.slot_key===k)).filter(Boolean);
  return `<div class="module module-hotel">
    ${canEdit()?`<div class="hbar"><span class="hbar-tag">🏨 酒店</span><span class="hacts"><button class="hedit" data-hid="${h.id}">✏️ 改信息</button><button class="hmig" data-hid="${h.id}">🔀 迁移</button><button class="hdel del" data-hid="${h.id}">📦 收仓库</button></span></div>`:""}
    <div class="mh-head">
      <div class="hn">${canEdit()?"":"🏨 "}${esc(h.name||"")}</div>
    </div>
    <div class="hmeta"><span class="lab">地址</span><span>${esc(h.address||"—")}</span></div>
    <div class="hmeta"><span class="lab">房型</span><span>${esc(h.room_type||"—")}</span></div>
    <div class="hmeta"><span class="lab">最近交通</span><span>${esc(h.nearest_transit||"—")}</span></div>
    ${h.url?`<div class="hmeta"><span class="lab">官网</span><a href="${esc(h.url)}" target="_blank" rel="noopener" style="color:var(--accent)">打开官网 ↗</a></div>`:""}
    ${(()=>{ const rp=hp.find(p=>p.slot_key==='hotel_route');
      if(rp) return `<div class="subcat"><div class="subcat-t">🗺 酒店到场馆路线</div><div class="slots docs">${docSlotHTML(rp,false)}</div></div>`;
      return canEdit()?`<div class="subcat"><div class="subcat-t">🗺 酒店到场馆路线</div><div class="slots docs"><div class="docslot empty addroute" data-hid="${h.id}"><div class="ico">🖼️</div><div class="lab">酒店到场馆路线 · 点击上传</div></div></div></div>`:""; })()}
    ${main.length?`<div class="slots" style="margin-top:10px">${main.map(slotHTML).join("")}</div>`:""}
    ${(()=>{ const ex=hp.filter(p=>!HMAIN.includes(p.slot_key)&&p.slot_key!=='hotel_route');
      return (ex.length||canEdit())?`<div class="subcat"><div class="subcat-t">📎 补充资料（路线/餐饮/住宿等 · 照片+备注）</div>
        <div class="slots docs">${ex.map(p=>docSlotHTML(p,true)).join("")}${canEdit()?addSlotBtnHTML(vid,h.id,'more','＋添加'):""}</div></div>`:""; })()}
    ${h.hotel_intro?`<div class="intro">${esc(fmtIntro(h.hotel_intro))}</div>`:""}
    ${tipsCardHTML(h.public_tips, `tips-h-${h.id}`)}
    ${canEdit()?internalCardHTML(h.internal_note, `int-h-${h.id}`):""}
    ${myNoteHTML('hotel',h.id)}
  </div>`;
}
function actHTML(a){
  const d=new Date(a.created_at);
  const ds=`${d.getMonth()+1}/${d.getDate()} ${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}`;
  return `<div class="actrow"><span class="aw">${esc(a.action||"")}${a.target?` 〔${esc(a.target)}〕`:""}</span><span class="at">${ds}</span></div>`;
}
function logHTML(l){
  const d=new Date(l.created_at); const ds=`${d.getMonth()+1}/${d.getDate()} ${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}`;
  return `<div class="log"><div class="meta">${ds}</div><div class="txt">${esc(l.content)}</div></div>`;
}

/* ---------------- 上传 ---------------- */
// 上传一个 File 到某坑位（点击选图 / 拍照 / 拖拽 共用）
async function doSlotUpload(file, p, el){
  if(!file || !/^image\//.test(file.type)){ toast("请选图片文件"); return; }
  const wasReplace=!!p.storage_path;
  el.classList.add("uploading");
  try{
    const blob=await compress(file);
    const path=p.storage_path || `${p.venue_id}/${p.hotel_id?(p.hotel_id.slice(0,8)+"_"):""}${p.slot_key}_${Math.random().toString(36).slice(2,6)}.jpg`;
    const {error:upErr}=await sb.storage.from(BUCKET).upload(path,blob,{upsert:true,contentType:"image/jpeg"});
    if(upErr) throw upErr;
    const nm=(prompt("给这张照片补充说明（如：距离酒店步行1分钟；留空就用坑位标题）：", (p.note||"").trim())||"").trim();
    const upd={storage_path:path,uploaded_by:whoami(),updated_at:new Date().toISOString()};
    if(nm) upd.note=nm;
    const {error:dbErr}=await sb.from("venue_photos").update(upd).eq("id",p.id);
    if(dbErr) throw dbErr;
    await logAct(p.venue_id, wasReplace?"替换照片":"上传照片", nm||p.slot_label);
    toast(wasReplace?"已替换 ✓":"上传成功 ✓");
    offerSaveToAlbum(file); maybeThank(); renderDetail(p.venue_id);
  }catch(e){ console.error(e); toast("上传失败："+(e.message||e)); el.classList.remove("uploading"); }
}
function pickAndUpload(p, el){
  const input=document.createElement("input");
  input.type="file"; input.accept="image/*"; // 不加 capture：让用户自选「拍照/相册/文件」
  input.onchange=()=>{ const f=input.files[0]; if(f) doSlotUpload(f, p, el); };
  input.click();
}
// 给坑位元素加拖拽上传（电脑端从文件夹拖图进来）
function enableSlotDrop(el, getP){
  el.addEventListener("dragover",e=>{ e.preventDefault(); el.classList.add("dragover"); });
  el.addEventListener("dragleave",()=>el.classList.remove("dragover"));
  el.addEventListener("drop",e=>{ e.preventDefault(); el.classList.remove("dragover");
    const f=e.dataTransfer.files&&e.dataTransfer.files[0]; if(f) doSlotUpload(f, getP(), el); });
}

/* 补充照片：随手拍，不限数量，可加备注 */
async function doExtraUpload(file, venueId, el){
  if(!file || !/^image\//.test(file.type)){ toast("请选图片文件"); return; }
  {
    el.classList.add("uploading");
    try{
      const blob=await compress(file);
      const key=`extra/${venueId}/${Date.now()}-${Math.round(performance.now())}.jpg`;
      const {error:upErr}=await sb.storage.from(BUCKET).upload(key,blob,{upsert:true,contentType:"image/jpeg"});
      if(upErr) throw upErr;
      const note=(prompt("给这张照片起个名字（导出图片时的文件名，可留空）：")||"").trim();
      const {error:dbErr}=await sb.from("extra_photos").insert({venue_id:venueId,storage_path:key,note:note||null,note_public:true,uploaded_by:whoami()});
      if(dbErr) throw dbErr;
      await logAct(venueId, "添加照片", note||"照片");
      toast("已添加 ✓"); offerSaveToAlbum(file); maybeThank(); renderDetail(venueId);
    }catch(e){ console.error(e); toast("上传失败："+(e.message||e)); el.classList.remove("uploading"); }
  }
}
function addExtraPhoto(venueId, el){
  const input=document.createElement("input");
  input.type="file"; input.accept="image/*"; // 拍照/相册/文件 都可
  input.onchange=()=>{ const f=input.files[0]; if(f) doExtraUpload(f, venueId, el); };
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
  let note=(canEdit()||ctx.rec.note_public!==false) ? noteOf(ctx).trim() : "";
  if(ctx.kind==="slot" && note===(ctx.rec.slot_label||"").trim()) note="";  // 与标题相同视作未填(C2)
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
  // 备注一律公开(C3)；要保密写进「内部提示·只读看不到」
  const {error}=await sb.from(table).update({note:val||null, note_public:true}).eq("id",noteCtx.rec.id);
  if(error){ toast("保存失败"); return; }
  await logAct(noteCtx.venueId, "编辑备注", noteCtx.kind==="slot"?noteCtx.rec.slot_label:"照片");
  notem.classList.remove("on"); toast(val?"备注已保存 ✓":"备注已清空"); maybeThank(); renderDetail(noteCtx.venueId);
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
let hotelEditing=null, hmMode="new";
function setHmMode(m){
  hmMode=m;
  document.getElementById("hm-mnew").classList.toggle("on",m==="new");
  document.getElementById("hm-mcopy").classList.toggle("on",m==="copy");
  document.getElementById("hm-copywrap").style.display = m==="copy"?"":"none";
  document.getElementById("hm-pastewrap").style.display = m==="new"?"":"none";  // 粘贴识别仅新建时
}

/* 智能粘贴：把一整段酒店信息按关键词/格式分类到各字段 */
function parseHotelBlob(raw){
  const out={name:"",address:"",room:"",transit:"",travel:"",url:"",intro:""};
  if(!raw||!raw.trim()) return out;
  const text=raw.replace(/\r/g,"").trim();
  // 先抓 URL（任何位置）
  const um=text.match(/https?:\/\/[^\s，。、]+/);
  if(um) out.url=um[0];
  const lines=text.split(/\n+/).map(s=>s.trim()).filter(Boolean);
  // 字段关键词 → 目标。labelRe=带标签前缀；valRe=无标签时按内容猜
  const RULES=[
    ["name",    /^(酒店名称|酒店名|名称|宾馆|hotel|ホテル名)[:：\s]/, null],
    ["address", /^(地址|住所|所在地|位置|住址)[:：\s]/, /(愛知県|爱知县|〒\s?\d|[都道府県市区町村].*\d|丁目|番地|号$)/],
    ["room",    /^(房型|房間|房间|户型|room|客室)[:：\s]/, /(单人|双人|双床|大床|标间|标准间|单间|和室|洋室|ツイン|ダブル|シングル)/],
    ["transit", /^(最近交通|交通|最寄|公共交通|车站|車站)[:：\s]/, /(地铁|地下鉄|电车|電車|徒歩|步行|駅|车站|公交|巴士|号线)/],
    ["travel",  /^(到场馆车程|车程|車程|到场馆|距场馆|drive)[:：\s]/, /((开车|駕車|大巴|车程).{0,6}\d|约?\s?\d+\s?(分钟|min))/],
    ["url",     /^(官网|网址|網址|链接|連結|url|主页|官方网站)[:：\s]/, /https?:\/\//],
    ["intro",   /^(简要介绍|介绍|介紹|简介|簡介|说明|備考|备注|概要|intro)[:：\s]/, null],
  ];
  let introLines=[], nameSet=false;
  for(let i=0;i<lines.length;i++){
    let ln=lines[i];
    // 1) 带标签的行 → 直接归类
    let matched=false;
    for(const [key,labelRe,valRe] of RULES){
      if(labelRe.test(ln)){
        const v=ln.replace(labelRe,"").trim();
        if(key==="intro"){ if(v) introLines.push(v); }
        else if(key==="name"){ if(v){out.name=v;nameSet=true;} }
        else if(!out[key]||key==="url") out[key]=v||out[key];
        matched=true; break;
      }
    }
    if(matched) continue;
    // 2) 第一个无标签行 → 当酒店名（几乎总在首行，常含地名，不让内容正则抢走）
    if(!nameSet && !out.name){ out.name=ln; nameSet=true; continue; }
    // 3) 其余无标签行：按内容特征猜
    let guessed=false;
    for(const [key,labelRe,valRe] of RULES){
      if(key==="intro"||key==="url"||key==="name") continue;
      if(valRe&&valRe.test(ln)&&!out[key]){ out[key]=ln; guessed=true; break; }
    }
    if(guessed) continue;
    introLines.push(ln);   // 兜底进介绍
  }
  if(introLines.length) out.intro=(out.intro?out.intro+"\n":"")+introLines.join("\n");
  // URL 若在介绍里重复出现就从介绍剔除
  if(out.url) out.intro=out.intro.replace(out.url,"").replace(/官网[:：]?\s*$/,"").trim();
  return out;
}
async function openAddHotel(venueId){
  hotelEditing={id:null, venueId};
  ["hm-name","hm-address","hm-room","hm-transit","hm-travel","hm-url","hm-intro","hm-paste"].forEach(i=>document.getElementById(i).value="");
  document.querySelector("#hotelm .ntitle").textContent="添加酒店";
  document.getElementById("hm-modesw").style.display="";   // 仅新增时显示模式切换
  setHmMode("new");
  // 填充可复制酒店下拉（跨场馆，显示 项目-酒店名）
  const [{data:hs},{data:vs}]=await Promise.all([
    sb.from("venue_hotels").select("id,name,venue_id").is("archived_at",null).order("sort_order"),
    sb.from("venues").select("id,category,c_code")]);
  const vmap={}; (vs||[]).forEach(v=>vmap[v.id]=(v.c_code?v.c_code+" ":"")+(v.category||""));
  const sel=document.getElementById("hm-copysrc");
  sel.innerHTML=(hs||[]).map(h=>`<option value="${h.id}">${esc((vmap[h.venue_id]||"")+" · "+(h.name||"酒店"))}</option>`).join("");
  hotelm.classList.add("on");
  setTimeout(()=>document.getElementById("hm-name").focus(),50);
}
function openHotelEditor(h, venueId){
  hotelEditing={id:h.id, venueId};
  document.getElementById("hm-modesw").style.display="none";   // 编辑时不显示
  document.getElementById("hm-copywrap").style.display="none";
  document.getElementById("hm-pastewrap").style.display="none";
  document.querySelector("#hotelm .ntitle").textContent="编辑酒店信息";
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
document.getElementById("hm-parse").onclick=()=>{
  const raw=document.getElementById("hm-paste").value;
  if(!raw.trim()){ toast("先把酒店信息贴进上面的框"); return; }
  const p=parseHotelBlob(raw);
  const setIf=(id,val)=>{ const el=document.getElementById(id); if(val) el.value=val; };
  setIf("hm-name",p.name); setIf("hm-address",p.address); setIf("hm-room",p.room);
  setIf("hm-transit",p.transit); setIf("hm-travel",p.travel); setIf("hm-url",p.url); setIf("hm-intro",p.intro);
  toast("已识别填入，请核对 ✓");
};
document.getElementById("hm-mnew").onclick=()=>setHmMode("new");
document.getElementById("hm-mcopy").onclick=async()=>{ setHmMode("copy");
  const id=document.getElementById("hm-copysrc").value; if(id) await hmPrefill(id); };
document.getElementById("hm-copysrc").onchange=(e)=>hmPrefill(e.target.value);
async function hmPrefill(hid){
  const {data:s}=await sb.from("venue_hotels").select("*").eq("id",hid).single();
  if(!s) return;
  const set=(i,val)=>document.getElementById(i).value=val||"";
  set("hm-name",s.name); set("hm-address",s.address); set("hm-room",s.room_type);
  set("hm-transit",s.nearest_transit); set("hm-travel",s.travel_time); set("hm-url",s.url); set("hm-intro",s.hotel_intro);
}
document.getElementById("hm-save").onclick=async()=>{
  if(!hotelEditing) return;
  const g=id=>document.getElementById(id).value.trim();
  const upd={ name:g("hm-name")||null, address:g("hm-address")||null, room_type:g("hm-room")||null,
    nearest_transit:g("hm-transit")||null, travel_time:g("hm-travel")||null, url:g("hm-url")||null, hotel_intro:g("hm-intro")||null };
  const saveBtn=document.getElementById("hm-save"); saveBtn.disabled=true;
  try{
    if(hotelEditing.id){
      const {error}=await sb.from("venue_hotels").update(upd).eq("id",hotelEditing.id);
      if(error){ toast("保存失败"); return; }
      await logAct(hotelEditing.venueId,"编辑酒店信息", upd.name||"酒店");
    } else if(hmMode==="copy"){
      const srcId=document.getElementById("hm-copysrc").value;
      if(!srcId){ toast("先选要复制的酒店"); return; }
      saveBtn.textContent="复制中…";
      const {data:src}=await sb.from("venue_hotels").select("*").eq("id",srcId).single();
      const {data:srcPhotos}=await sb.from("venue_photos").select("*").eq("hotel_id",srcId);
      const newHid=crypto.randomUUID();
      Object.assign(upd,{ id:newHid, venue_id:hotelEditing.venueId, sort_order:99,
        public_tips:src.public_tips, internal_note:src.internal_note, lat:src.lat, lng:src.lng });
      const {error}=await sb.from("venue_hotels").insert(upd);
      if(error){ toast("复制失败"); return; }
      await copyPhotos(srcPhotos||[], hotelEditing.venueId, newHid);
      await logAct(hotelEditing.venueId,"复制酒店(自"+(src.name||"")+")", upd.name||"酒店");
    } else {
      upd.venue_id=hotelEditing.venueId; upd.sort_order=99;
      const newHid=crypto.randomUUID(); upd.id=newHid;
      const {error}=await sb.from("venue_hotels").insert(upd);
      if(error){ toast("添加失败"); return; }
      // 新酒店配 6 个标准空坑位
      const HS=[["hotel_route","酒店到场馆路线","paste",9],["hotel_exterior","酒店外观","photo",10],["hotel_map","酒店官网及周边地图","paste",11],["hotel_lobby","酒店大堂","photo",12],["hotel_surround_1","酒店周边①","photo",13],["hotel_surround_2","酒店周边②","photo",14],["hotel_surround_3","酒店周边③","photo",15]];
      await sb.from("venue_photos").insert(HS.map(s=>({venue_id:hotelEditing.venueId,hotel_id:newHid,slot_key:s[0],slot_group:"酒店",slot_label:s[1],slot_type:s[2],storage_path:null,sort_order:s[3]})));
      await logAct(hotelEditing.venueId,"添加酒店", upd.name||"酒店");
    }
    hotelm.classList.remove("on"); toast("已保存"); maybeThank(); renderDetail(hotelEditing.venueId);
  } finally { saveBtn.disabled=false; saveBtn.textContent="保存"; }
};
/* 录入类弹窗不再「点背景关闭」——防止填一半误触背景把弹窗关掉丢数据（之前 Chrome 上反映的"输入几下退回场馆页"） */

/* ---------------- 添加场馆 ---------------- */
const addm=document.getElementById("addm");
// 新建场馆只配 概览+场馆 共9坑；酒店坑由「添加酒店」时各自生成(避免无主幽灵坑)
const ADD_SLOTS=[
 ["route_map","概览","谷歌路线图（酒店→场馆）","paste",1],["lodging_table","概览","住宿信息表","paste",2],["dining_table","概览","餐饮信息统计表","paste",3],
 ["venue_exterior","场馆","场馆外观","photo",4],["venue_map","场馆","场馆谷歌地图","paste",5],["venue_parking","场馆","上车点／大巴停车场","photo",6],
 ["venue_surround_1","场馆","场馆周边①","photo",7],["venue_surround_2","场馆","场馆周边②","photo",8],["venue_surround_3","场馆","场馆周边③","photo",9],
];
let amMode="new";
// 独立拷贝照片（下载原图→上传到新路径→插入新行，互不影响）
async function copyPhotos(srcRows, vid, hid){
  for(const p of srcRows){
    let newPath=null;
    if(p.storage_path){
      try{
        const blob=await fetch(pubUrl(p.storage_path)).then(r=>r.ok?r.blob():null);
        if(blob){
          newPath=`${vid}/${hid?(hid.slice(0,8)+"_"):""}${p.slot_key}_${Math.random().toString(36).slice(2,6)}.jpg`;
          const {error}=await sb.storage.from(BUCKET).upload(newPath,blob,{upsert:true,contentType:"image/jpeg"});
          if(error) newPath=null;
        }
      }catch(e){ newPath=null; }
    }
    await sb.from("venue_photos").insert({venue_id:vid, hotel_id:hid||null, slot_key:p.slot_key,
      slot_group:p.slot_group, slot_label:p.slot_label, slot_type:p.slot_type, storage_path:newPath,
      note:p.note, note_public:p.note_public, caption:p.caption, sort_order:p.sort_order});
  }
}
function setAmMode(m){
  amMode=m;
  document.getElementById("am-mnew").classList.toggle("on",m==="new");
  document.getElementById("am-mcopy").classList.toggle("on",m==="copy");
  document.getElementById("am-copywrap").style.display = m==="copy"?"":"none";
}
async function openAddVenue(){
  ["am-cat","am-team","am-code","am-name","am-addr"].forEach(id=>document.getElementById(id).value="");
  document.getElementById("am-type").value="LIVE";
  setAmMode("new");
  // 填充可复制场馆下拉
  const {data:vlist}=await sb.from("venues").select("id,c_code,category").order("sort_order");
  const sel=document.getElementById("am-copysrc");
  sel.innerHTML=(vlist||[]).map(v=>`<option value="${v.id}">${esc((v.c_code?v.c_code+" ":"")+(v.category||"未命名"))}</option>`).join("");
  addm.classList.add("on");
  setTimeout(()=>document.getElementById("am-cat").focus(),50);
}
document.getElementById("am-mnew").onclick=()=>setAmMode("new");
document.getElementById("am-mcopy").onclick=async()=>{
  setAmMode("copy");
  const sel=document.getElementById("am-copysrc");
  if(sel.value){ const {data:s}=await sb.from("venues").select("venue_name_jp,venue_address").eq("id",sel.value).single();
    if(s){ document.getElementById("am-name").value=s.venue_name_jp||""; document.getElementById("am-addr").value=s.venue_address||""; } }
};
document.getElementById("am-copysrc").onchange=async(e)=>{
  const {data:s}=await sb.from("venues").select("venue_name_jp,venue_address").eq("id",e.target.value).single();
  if(s){ document.getElementById("am-name").value=s.venue_name_jp||""; document.getElementById("am-addr").value=s.venue_address||""; }
};
document.getElementById("am-cancel").onclick=()=>addm.classList.remove("on");
/* addm 同 hotelm：去掉点背景关闭，防误关丢数据 */
document.getElementById("am-save").onclick=async()=>{
  const cat=document.getElementById("am-cat").value.trim();
  if(!cat){ toast("项目名称必填"); return; }
  const g=id=>document.getElementById(id).value.trim();
  const vid=crypto.randomUUID();
  const venue={ id:vid, category:cat, team:g("am-team")||null, c_code:g("am-code")||null,
    venue_name_jp:g("am-name")||null, venue_address:g("am-addr")||null,
    team_type:document.getElementById("am-type").value, survey_done:false, sort_order:200 };
  const saveBtn=document.getElementById("am-save"); saveBtn.disabled=true;
  try{
    if(amMode==="copy"){
      const srcId=document.getElementById("am-copysrc").value;
      if(!srcId){ toast("先选要复制的场馆"); saveBtn.disabled=false; return; }
      saveBtn.textContent="复制中…";
      const {data:src}=await sb.from("venues").select("*").eq("id",srcId).single();
      const {data:srcPhotos}=await sb.from("venue_photos").select("*").eq("venue_id",srcId).is("hotel_id",null);
      Object.assign(venue,{ nearest_transit:src.nearest_transit, parking_note:src.parking_note,
        lat:src.lat, lng:src.lng, venue_intro:src.venue_intro, public_tips:src.public_tips, internal_note:src.internal_note });
      const {error}=await sb.from("venues").insert(venue);
      if(error){ toast("建馆失败"); saveBtn.disabled=false; saveBtn.textContent="建好，去填坑位"; return; }
      await copyPhotos(srcPhotos||[], vid, null);
      await logAct(vid,"复制场馆(自"+(src.category||"")+")",cat);
    } else {
      const {error}=await sb.from("venues").insert(venue);
      if(error){ toast("建馆失败"); saveBtn.disabled=false; return; }
      await sb.from("venue_photos").insert(ADD_SLOTS.map(s=>({venue_id:vid,slot_key:s[0],slot_group:s[1],slot_label:s[2],slot_type:s[3],storage_path:null,sort_order:s[4]})));
      await logAct(vid,"新建场馆",cat);
    }
    addm.classList.remove("on"); toast("场馆已建好 ✓");
    location.hash="#/venue/"+vid;
  } finally { saveBtn.disabled=false; saveBtn.textContent="建好，去填坑位"; }
};

/* ---------------- 编辑场馆基本信息 ---------------- */
// 绿色区：项目概览（项目名/团队/C码/类型/车程/工期/人数）
const herom=document.getElementById("herom");
let heroEditing=null;
function openHeroEditor(v){
  heroEditing=v.id;
  const set=(id,val)=>document.getElementById(id).value=val||"";
  set("hr-cat",v.category); set("hr-team",v.team); set("hr-code",v.c_code);
  document.getElementById("hr-type").value=v.team_type||"LIVE";
  set("hr-travel",v.travel_time); set("hr-start",v.work_start); set("hr-end",v.work_end); set("hr-size",v.team_size);
  herom.classList.add("on");
}
document.getElementById("hr-cancel").onclick=()=>herom.classList.remove("on");
/* herom 同 hotelm：去掉点背景关闭，防误关丢数据 */
document.getElementById("hr-save").onclick=async()=>{
  if(!heroEditing) return;
  const g=id=>document.getElementById(id).value.trim();
  const ws=g("hr-start")||null, we=g("hr-end")||null;
  let days=null; if(ws&&we){ const d=Math.round((new Date(we)-new Date(ws))/86400000)+1; if(d>0) days=d; }
  const upd={ category:g("hr-cat")||null, team:g("hr-team")||null, c_code:g("hr-code")||null,
    team_type:document.getElementById("hr-type").value, travel_time:g("hr-travel")||null,
    work_start:ws, work_end:we, work_days:days, team_size:g("hr-size")||null };
  const {error}=await sb.from("venues").update(upd).eq("id",heroEditing);
  if(error){ toast("保存失败"); return; }
  await logAct(heroEditing,"编辑项目概览", upd.category||"概览");
  herom.classList.remove("on"); toast("已保存"); maybeThank(); renderDetail(heroEditing);
};

// 白色区：基本信息（场馆名/地址/交通/停车/简介）
const venuem=document.getElementById("venuem");
let venueEditing=null;
function openVenueEditor(v){
  venueEditing=v.id;
  const set=(id,val)=>document.getElementById(id).value=val||"";
  set("vm-name",v.venue_name_jp); set("vm-addr",v.venue_address);
  set("vm-transit",v.nearest_transit); set("vm-parking",v.parking_note); set("vm-intro",v.venue_intro);
  venuem.classList.add("on");
}
document.getElementById("vm-cancel").onclick=()=>venuem.classList.remove("on");
/* venuem 同 hotelm：去掉点背景关闭，防误关丢数据 */
document.getElementById("vm-save").onclick=async()=>{
  if(!venueEditing) return;
  const g=id=>document.getElementById(id).value.trim();
  const upd={ venue_name_jp:g("vm-name")||null, venue_address:g("vm-addr")||null,
    nearest_transit:g("vm-transit")||null, parking_note:g("vm-parking")||null, venue_intro:g("vm-intro")||null };
  const {error}=await sb.from("venues").update(upd).eq("id",venueEditing);
  if(error){ toast("保存失败"); return; }
  await logAct(venueEditing,"编辑基本信息", upd.venue_name_jp||"场馆");
  venuem.classList.remove("on"); toast("已保存"); maybeThank(); renderDetail(venueEditing);
};

/* ---------------- 比赛项目 增/改 ---------------- */
const eventm=document.getElementById("eventm");
let eventEditing=null;
function openEventEditor(e, venueId){
  eventEditing={id:e?e.id:null, venueId};
  document.getElementById("eventm-title").textContent=e?"编辑比赛项目":"添加比赛项目";
  document.getElementById("em-name").value=e?.name||"";
  document.getElementById("em-en").value=e?.name_en||"";
  document.getElementById("em-jp").value=e?.note||"";
  document.getElementById("em-sched").value=e?.schedule||"";
  eventm.classList.add("on");
  setTimeout(()=>document.getElementById("em-name").focus(),50);
}
document.getElementById("em-cancel").onclick=()=>eventm.classList.remove("on");
/* eventm 同 hotelm：去掉点背景关闭，防误关丢数据 */
document.getElementById("em-save").onclick=async()=>{
  if(!eventEditing) return;
  const g=id=>document.getElementById(id).value.trim();
  const name=g("em-name"); if(!name){ toast("项目名称必填"); return; }
  const data={ name, name_en:g("em-en")||null, note:g("em-jp")||null, schedule:g("em-sched")||null };
  if(eventEditing.id){
    await sb.from("venue_events").update(data).eq("id",eventEditing.id);
    await logAct(eventEditing.venueId,"编辑项目",name);
  } else {
    data.venue_id=eventEditing.venueId; data.sort_order=99;
    await sb.from("venue_events").insert(data);
    await logAct(eventEditing.venueId,"添加项目",name);
  }
  eventm.classList.remove("on"); toast("已保存"); maybeThank(); renderDetail(eventEditing.venueId);
};

/* ---------------- 整块迁移（酒店 / 项目 → 其他场馆）---------------- */
const migm=document.getElementById("migm");
let migCtx=null;
async function openMigrate(kind, rec, fromVenueId){
  migCtx={kind, rec, fromVenueId};
  const label = kind==="hotel" ? ("酒店「"+(rec.name||"")+"」") : ("项目「"+(rec.name||"")+"」");
  document.getElementById("mig-what").textContent="把 "+label+" 整块迁移到另一个场馆（信息原样搬过去，并留下操作记录）";
  const {data}=await sb.from("venues").select("id,c_code,category,team").order("sort_order");
  const sel=document.getElementById("mig-target");
  sel.innerHTML=(data||[]).filter(x=>x.id!==fromVenueId)
    .map(x=>`<option value="${x.id}">${x.c_code?esc(x.c_code)+" ":""}${esc(x.category||"")}${x.team?" ("+esc(x.team)+")":""}</option>`).join("");
  migm.classList.add("on");
}
document.getElementById("mig-cancel").onclick=()=>migm.classList.remove("on");
migm.addEventListener("click",e=>{ if(e.target===migm) migm.classList.remove("on"); });
document.getElementById("mig-confirm").onclick=async()=>{
  if(!migCtx) return;
  const target=document.getElementById("mig-target").value; if(!target) return;
  const table=migCtx.kind==="hotel"?"venue_hotels":"venue_events";
  const {error}=await sb.from(table).update({venue_id:target}).eq("id",migCtx.rec.id);
  if(error){ toast("迁移失败"); return; }
  // 酒店整体迁移：连同它的照片 + 我的笔记一起搬到目标场馆
  if(migCtx.kind==="hotel"){
    await sb.from("venue_photos").update({venue_id:target}).eq("hotel_id",migCtx.rec.id);
    await sb.from("section_notes").update({venue_id:target}).eq("hotel_id",migCtx.rec.id);
  }
  const what=(migCtx.kind==="hotel"?"酒店":"项目")+"「"+(migCtx.rec.name||"")+"」";
  const tgtName=document.getElementById("mig-target").selectedOptions[0]?.textContent||"目标馆";
  await logAct(migCtx.fromVenueId, "迁出"+(migCtx.kind==="hotel"?"酒店":"项目"), (migCtx.rec.name||"")+" → "+tgtName);
  await logAct(target, "迁入"+(migCtx.kind==="hotel"?"酒店":"项目"), migCtx.rec.name||"");
  migm.classList.remove("on"); toast("已迁移到 "+tgtName+" ✓"); renderDetail(migCtx.fromVenueId);
};

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
  const note = (canEdit()||r.note_public!==false) ? noteOf(ctx).trim() : "";
  let cap=label; if(preset) cap+=" · "+preset; if(note) cap+="\n📝 "+note;
  document.getElementById("lb-cap").textContent=cap;
  // 按钮（编辑权限 + 麦当劳彩蛋）
  let html="";
  if(canEdit()){
    html+=`<button id="lb-note">${note?"编辑备注":"加备注"}</button>`;
    html+=`<button id="lb-replace">替换这张</button>`;
    if(ctx.kind==="extra") html+=`<button id="lb-del" class="danger">📦 收进仓库</button>`;
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
  input.type="file"; input.accept="image/*"; // 拍照或相册都可
  input.onchange=async()=>{
    const file=input.files[0]; if(!file) return;
    try{
      const blob=await compress(file);
      const {error:upErr}=await sb.storage.from(BUCKET).upload(e.storage_path,blob,{upsert:true,contentType:"image/jpeg"});
      if(upErr) throw upErr;
      const nm=(prompt("给这张照片起个名字（导出图片时的文件名，可留空保留原名）：", (e.note||"").trim())||"").trim();
      const upd={created_at:new Date().toISOString()}; if(nm) upd.note=nm;
      await sb.from("extra_photos").update(upd).eq("id",e.id);
      await logAct(venueId, "替换补充照片", nm||"补充照片");
      toast("已替换 ✓"); maybeThank(); renderDetail(venueId);
    }catch(err){ toast("替换失败"); }
  };
  input.click();
}
async function deleteExtra(){
  if(!confirm("把这张照片收进仓库？（不会真删，需要时能从仓库捞回来）")) return;
  const e=lbCtx.rec;
  const {error}=await sb.from("extra_photos").update({archived_at:new Date().toISOString()}).eq("id",e.id);
  if(error){ toast("操作失败"); return; }
  await logAct(lbCtx.venueId, "收进仓库·补充照片", "补充照片");
  lb.classList.remove("on"); toast("已收进仓库 📦"); maybeThank(); renderDetail(lbCtx.venueId);
}
document.getElementById("lb-close").onclick=()=>{ stopJingle(); lb.classList.remove("on"); };
lb.addEventListener("click",e=>{ if(e.target===lb){ stopJingle(); lb.classList.remove("on"); } });

/* ---------------- 登录页轮播小贴士 ---------------- */
const GATE_TIPS=[
  ["📦","暂时不要的酒店或照片，可以先「收进仓库」，需要时还能再捞出来"],
  ["🔀","酒店信息能整体打包迁移——组委会换了分配，一键搬到别的场馆"],
  ["📋","加酒店时把信息整段粘进去，点一下自动分好类，不用一格一格敲"],
  ["📸","现场点坑位即拍即传；放不下的照片都收进「补充照片」"],
  ["✍️","每个场馆能写「进度备注」，还差什么写一句，方便交接"],
  ["🗺","酒店和场馆都在地图上；绿=LIVE 橙=ENG，一眼看清"],
  ["🐙","TAKO 是大家一起踏勘的资料库——你填的每一条，队友都用得上"],
];
function startGateTips(){
  const el=document.getElementById("gate-tips"); if(!el) return;
  let i=0;
  const show=()=>{
    const [ico,txt]=GATE_TIPS[i%GATE_TIPS.length];
    el.innerHTML=`<span class="gt-ico">${ico}</span>${txt}`;
    el.classList.add("show");
  };
  show();
  setInterval(()=>{
    el.classList.remove("show");
    setTimeout(()=>{ i++; show(); }, 520);
  }, 4800);
}
startGateTips();

/* ---------------- 启动 ---------------- */
route();
