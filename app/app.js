/* Qala.fix — пилотное приложение. Правила: ../spec-rules.md, база: supabase/schema.sql */
"use strict";

// ---------- Справочники ----------
const CATS = {
  manhole:  {name:"Открытый люк", sev:3},
  wires:    {name:"Оголённые провода", sev:3},
  sinkhole: {name:"Провал дороги", sev:3},
  pothole:  {name:"Яма на дороге", sev:2},
  paving:   {name:"Разбит тротуар / брусчатка", sev:2},
  light:    {name:"Не работает освещение", sev:2},
  traffic:  {name:"Не работает светофор", sev:2},
  drain:    {name:"Ливнёвка, лужа", sev:1},
  trash:    {name:"Мусор, свалка", sev:1},
  bench:    {name:"Сломана скамейка / урна", sev:1},
  other:    {name:"Другое", sev:1},
};
const SEV = {3:"Опасно для жизни", 2:"Серьёзно", 1:"Неудобство"};
const CITIES = {
  astana: {name:"Астана", center:[51.1282, 71.4304], zoom:12},
  almaty: {name:"Алматы", center:[43.2380, 76.9450], zoom:12},
};
const STATUS = {
  collecting: "Собираем подтверждения",
  to_send:    "Готово к отправке в акимат",
  sent:       "Отправлено, ждём ответа",
  in_work:    "Акимат ответил, в работе",
  verifying:  "Проверка ремонта жителями",
  fixed:      "Исправлено",
};
const FIX_NEEDED = 3, NOTFIX_NEEDED = 2, REOPEN_NEEDED = 2, SEND_MIN_CONF = 2, DUP_RADIUS = 120, GEO_RADIUS = 150;
const COLOR_NAME = {red:"Опасно", orange:"Срочно", yellow:"Неудобство", green:"Исправлено"};

const ERRORS = {
  not_member: "Сначала войдите по инвайт-коду.",
  bad_code: "Код не подошёл. Проверьте написание или попросите новый.",
  already_voted: "Вы уже голосовали за эту точку.",
  already_fixed: "Точка уже отмечена исправленной.",
  wrong_status: "Сейчас это действие недоступно для этой точки.",
  rate_limit: "Лимит: не больше 15 жалоб в сутки.",
  outside_kz: "Точка вне Казахстана.",
  no_location: "Нужна геолокация телефона.",
  forbidden: "Недостаточно прав.",
  custom_type_required: "Напишите, что за проблема.",
  empty_ticket: "Введите номер обращения.",
  photo_required: "Для «сделано плохо» нужно свежее фото с места.",
};

// ---------- Состояние ----------
const CFG = window.QALA_CONFIG || {};
const S = {
  sb: null, session: null, profile: null,
  votes: new Set(),          // "id:kind:round"
  complaints: [], byId: new Map(),
  city: localGet("qala.city") || CFG.DEFAULT_CITY || "astana",
  filter: "all",
  map: null, layer: null,
  draft: null,
};

// ---------- Утилиты ----------
function localGet(k){ try { return localStorage.getItem(k); } catch { return null; } }
function localSet(k,v){ try { localStorage.setItem(k,v); } catch {} }
const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, ch => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[ch]));
const DAY = 86400000;
const daysSince = t => t ? Math.max(0, Math.floor((Date.now() - new Date(t).getTime()) / DAY)) : 0;
const fmtDate = t => t ? new Date(t).toLocaleDateString("ru-RU", {day:"numeric", month:"long", year:"numeric"}) : "";
function plural(n, one, few, many){ const m10=n%10, m100=n%100; return n + " " + (m10===1&&m100!==11 ? one : m10>=2&&m10<=4&&(m100<12||m100>14) ? few : many); }
function distM(a, b, c, d){ const R=6371000, r=Math.PI/180, x=Math.sin((c-a)*r/2)**2 + Math.cos(a*r)*Math.cos(c*r)*Math.sin((d-b)*r/2)**2; return 2*R*Math.asin(Math.sqrt(x)); }
function toast(msg, ms=3200){ const t=$("#toast"); t.textContent=msg; t.hidden=false; clearTimeout(toast._t); toast._t=setTimeout(()=>t.hidden=true, ms); }
function errText(e){
  const m = String(e?.message || e || "");
  const far = m.match(/too_far:(\d+)/);
  if (far) return `Вы в ${far[1]} м от точки. Голос принимается только ближе ${GEO_RADIUS} м: подойдите к месту.`;
  for (const k in ERRORS) if (m.includes(k)) return ERRORS[k];
  if (/Failed to fetch|NetworkError|network/i.test(m)) return "Нет связи с сервером. Проверьте интернет.";
  return "Ошибка: " + m;
}
async function busy(btn, fn){
  const old = btn?.innerHTML; if (btn){ btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>'; }
  try { return await fn(); } catch(e){ console.error(e); toast(errText(e), 5000); }
  finally { if (btn && btn.isConnected){ btn.disabled = false; btn.innerHTML = old; } }
}
function photoUrl(path){ return path ? S.sb.storage.from("photos").getPublicUrl(path).data.publicUrl : null; }
function appLink(id){ return location.origin + location.pathname + "#c=" + id; }

// ---------- Правила цвета (spec-rules.md, п. 2) ----------
function sevOf(c){
  if (c.cat === "other") return c.moderated ? (c.custom_sev || 1) : Math.min(c.custom_sev || 1, 2);
  return CATS[c.cat]?.sev || 1;
}
function catName(c){ return c.cat === "other" ? (c.custom_type || "Другое") + (c.moderated ? "" : " (свой вариант)") : (CATS[c.cat]?.name || c.cat); }
function daysUnanswered(c){ return c.status === "sent" ? daysSince(c.sent_at) : 0; }
function scoreOf(c){
  const sev = sevOf(c), conf = c.conf_count || 0, d = daysUnanswered(c);
  return sev + (conf >= 10 ? 2 : conf >= 3 ? 1 : 0) + (d >= 30 ? 2 : d >= 15 ? 1 : 0);
}
function colorOf(c){
  if (c.status === "fixed") return "green";
  const sev = sevOf(c), sc = scoreOf(c);
  let col = (sev === 3 || sc >= 5) ? "red" : sc >= 3 ? "orange" : "yellow";
  if (sev === 1 && col === "red") col = "orange";
  return col;
}
const hasVote = (c, kind) => S.votes.has(`${c.id}:${kind}:${kind === "confirm" ? 0 : c.round}`);
const isMine = c => S.session && c.author === S.session.user.id;
const isMod = () => S.profile?.role === "moderator";

// ---------- Старт ----------
async function init(){
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(()=>{});
  initMap();
  bindUI();
  if (!CFG.SUPABASE_URL || !CFG.SUPABASE_ANON_KEY){
    openSheet(`<h2>Приложение ещё не подключено к базе</h2>
      <p class="muted">Заполните <code>app/config.js</code> (Project URL и anon key из Supabase) и примените <code>app/supabase/schema.sql</code>. Инструкция в <code>app/README.md</code>.</p>`);
    return;
  }
  S.sb = supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY, {auth:{persistSession:true, autoRefreshToken:true}});
  const { data } = await S.sb.auth.getSession();
  S.session = data.session;
  S.sb.auth.onAuthStateChange((_e, session) => { S.session = session; });
  await Promise.all([loadMe(), loadComplaints()]);
  routeHash();
  setInterval(() => { if (!document.hidden) loadComplaints(); }, 60000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) loadComplaints(); });
}

async function loadMe(){
  S.profile = null; S.votes = new Set();
  if (!S.session) return;
  const uid = S.session.user.id;
  const [p, v] = await Promise.all([
    S.sb.from("profiles").select("*").eq("id", uid).maybeSingle(),
    S.sb.from("votes").select("complaint_id,kind,round").eq("user_id", uid),
  ]);
  S.profile = p.data || null;
  for (const r of (v.data || [])) S.votes.add(`${r.complaint_id}:${r.kind}:${r.round}`);
}

async function loadComplaints(){
  const { data, error } = await S.sb.from("complaints").select("*").eq("city", S.city)
    .order("created_at", {ascending:false}).limit(3000);
  if (error){ toast(errText(error)); return; }
  S.complaints = data || [];
  S.byId = new Map(S.complaints.map(c => [c.id, c]));
  renderMarkers();
}

// ---------- Карта ----------
function initMap(){
  const city = CITIES[S.city] || CITIES.astana;
  $("#city").value = S.city;
  S.map = L.map("map", {zoomControl:false, attributionControl:true}).setView(city.center, city.zoom);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19, attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(S.map);
  L.control.zoom({position:"topright"}).addTo(S.map);
  S.layer = L.layerGroup().addTo(S.map);
}
function renderMarkers(){
  S.layer.clearLayers();
  for (const c of S.complaints){
    const col = colorOf(c);
    if (S.filter === "mine" ? !isMine(c) : (S.filter !== "all" && S.filter !== col)) continue;
    const cls = `marker ${col}${c.status === "collecting" ? " collecting" : ""}${isMine(c) ? " mine" : ""}${c.hidden ? " hidden" : ""}`;
    const icon = L.divIcon({className:"", html:`<div class="${cls}"></div>`, iconSize:[22,22], iconAnchor:[11,11]});
    L.marker([c.lat, c.lng], {icon, title: catName(c)}).on("click", () => openComplaint(c.id)).addTo(S.layer);
  }
}

// ---------- Шторка ----------
function openSheet(html){
  $("#sheetBody").innerHTML = html;
  $("#sheet").hidden = false; $("#sheetBackdrop").hidden = false;
  $("#sheet").scrollTop = 0;
}
function closeSheet(){
  $("#sheet").hidden = true; $("#sheetBackdrop").hidden = true;
  if (location.hash.startsWith("#c=")) history.replaceState(null, "", location.pathname + location.search);
}

function bindUI(){
  $("#sheetBackdrop").onclick = closeSheet;
  $("#sheet").addEventListener("click", e => { if (e.target.closest("[data-close]")) closeSheet(); });
  $("#city").onchange = e => {
    S.city = e.target.value; localSet("qala.city", S.city);
    const c = CITIES[S.city]; S.map.setView(c.center, c.zoom); if (S.sb) loadComplaints();
  };
  $("#filters").onclick = e => {
    const b = e.target.closest(".chip"); if (!b) return;
    document.querySelectorAll(".chip").forEach(x => x.classList.toggle("on", x === b));
    S.filter = b.dataset.f; renderMarkers();
  };
  $("#addBtn").onclick = startReport;
  $("#menuBtn").onclick = openMenu;
  $("#locateBtn").onclick = async () => {
    try { const p = await getPosition(); S.map.setView([p.lat, p.lng], 17); }
    catch(e){ toast(e.message); }
  };
  $("#pickOk").onclick = finishPick;
  $("#pickCancel").onclick = () => { endPick(); renderReport(); };
  window.addEventListener("hashchange", routeHash);
}
function routeHash(){
  const m = location.hash.match(/^#c=(\d+)/);
  if (m) openComplaint(Number(m[1]));
}

// ---------- Геолокация ----------
function getPosition(){
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error("Телефон не отдаёт геолокацию."));
    navigator.geolocation.getCurrentPosition(
      p => resolve({lat:p.coords.latitude, lng:p.coords.longitude, acc:p.coords.accuracy}),
      e => reject(new Error(e.code === 1 ? "Разрешите доступ к геолокации в настройках браузера." : "Не удалось определить местоположение. Выйдите на открытое место и попробуйте ещё раз.")),
      {enableHighAccuracy:true, timeout:15000, maximumAge:30000});
  });
}
async function reverseGeocode(lat, lng){
  try {
    const r = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&accept-language=ru&zoom=18&lat=${lat}&lon=${lng}`);
    const j = await r.json(); const a = j.address || {};
    const street = [a.road || a.pedestrian || a.footway || a.neighbourhood, a.house_number].filter(Boolean).join(", ");
    return street || (j.display_name || "").split(",").slice(0,2).join(",");
  } catch { return ""; }
}

// ---------- Вход по инвайт-коду ----------
function ensureMember(then){
  if (S.profile && !S.profile.banned) return true;
  if (S.profile?.banned){ toast("Ваш аккаунт заблокирован модератором."); return false; }
  openJoin(then); return false;
}
function openJoin(then){
  openSheet(`<h2>Вход в пилот Qala.fix</h2>
    <p class="muted">Сейчас приложение тестируют приглашённые жители. Введите код из приглашения.</p>
    <div class="stack">
      <label class="field"><span>Инвайт-код</span><input id="code" autocomplete="off" autocapitalize="characters" placeholder="QALA-XXXXXX"></label>
      <label class="check"><input type="checkbox" id="consent">
        <span>Я согласен(на) на обработку данных по <a href="privacy.html" target="_blank">условиям пилота</a>: фото, координаты проблемы и описание будут опубликованы на карте. Имя и телефон не собираются.</span></label>
      <button class="btn" id="joinBtn">Войти</button>
    </div>`);
  $("#joinBtn").onclick = e => busy(e.currentTarget, async () => {
    const code = $("#code").value.trim();
    if (!code) throw new Error("Введите код.");
    if (!$("#consent").checked) throw new Error("Нужно согласие с условиями.");
    if (!S.session){
      const { data, error } = await S.sb.auth.signInAnonymously();
      if (error) throw error; S.session = data.session;
    }
    const { error } = await S.sb.rpc("join_pilot", {p_code: code});
    if (error) throw error;
    await loadMe(); renderMarkers();
    toast(isMod() ? "Вы вошли как модератор." : "Готово, вы в пилоте.");
    closeSheet(); if (then) then();
  });
}

// ---------- Новая жалоба ----------
async function startReport(){
  if (!S.sb) return;
  if (!ensureMember(startReport)) return;
  S.draft = {photo:null, photoUrl:null, lat:null, lng:null, address:"", cat:null, customType:"", customSev:2, desc:"", locating:true};
  renderReport();
  try {
    const p = await getPosition();
    if (!S.draft) return;
    const city = CITIES[S.city];
    if (distM(p.lat, p.lng, city.center[0], city.center[1]) < 60000){
      Object.assign(S.draft, {lat:p.lat, lng:p.lng});
      S.map.setView([p.lat, p.lng], 17);
      S.draft.address = await reverseGeocode(p.lat, p.lng);
    }
  } catch(e){ /* не страшно: отметят на карте вручную */ }
  if (S.draft){ S.draft.locating = false; if (!$("#sheet").hidden && $("#rp")) renderReport(); }
}
function renderReport(){
  const d = S.draft;
  const catBtns = Object.entries(CATS).map(([k,v]) =>
    `<button class="cat${d.cat===k?" on":""}" data-cat="${k}">${esc(v.name)}<small>${k==="other" ? "свой вариант" : SEV[v.sev]}</small></button>`).join("");
  const loc = d.lat ? `<b>${esc(d.address || "Точка на карте")}</b><div class="muted small">${d.lat.toFixed(5)}, ${d.lng.toFixed(5)}</div>`
    : d.locating ? `<span class="muted">Определяем местоположение…</span>` : `<span class="muted">Место не выбрано</span>`;
  openSheet(`<div id="rp"><h2>Сообщить о проблеме</h2>
    <div class="stack">
      <label class="photo-pick">${d.photoUrl ? `<img src="${d.photoUrl}" alt="">` : `<div style="font-size:30px">📷</div><div><b>Сфотографируйте проблему</b></div><div class="small">Данные о телефоне и GPS из файла удаляются</div>`}
        <input type="file" id="photoIn" accept="image/*" capture="environment"></label>
      <div class="box row"><div style="flex:1">${loc}</div><button class="btn sm light" id="pickBtn">${d.lat ? "Уточнить" : "На карте"}</button></div>
      <h3>Что случилось?</h3>
      <div class="cats">${catBtns}</div>
      ${d.cat === "other" ? `
        <label class="field"><span>Что за проблема (до 60 символов)</span><input id="customType" maxlength="60" value="${esc(d.customType)}" placeholder="Например: упало дерево"></label>
        <label class="field"><span>Насколько опасно</span><select id="customSev">
          ${[3,2,1].map(s => `<option value="${s}"${d.customSev==s?" selected":""}>${SEV[s]}</option>`).join("")}</select></label>
        <div class="muted small">До проверки модератором свой вариант считается не выше «серьёзно».</div>` : ""}
      <label class="field"><span>Комментарий (необязательно)</span><textarea id="desc" maxlength="1000" placeholder="Например: яма глубокая, уже пробили колесо">${esc(d.desc)}</textarea></label>
      <button class="btn" id="sendBtn">Отправить на карту</button>
      <div class="muted small">Жалоба станет видна всем. Когда её подтвердит ещё один житель, она попадёт в очередь на отправку в eOtinish / iKomek 109. Опасные проблемы попадают туда сразу.</div>
    </div></div>`);
  const keep = () => { if ($("#desc")) d.desc = $("#desc").value; if ($("#customType")) d.customType = $("#customType").value; if ($("#customSev")) d.customSev = Number($("#customSev").value); };
  $("#photoIn").onchange = async e => {
    const f = e.target.files[0]; if (!f) return; keep();
    try {
      d.photo = await compressImage(f);
      if (d.photoUrl) URL.revokeObjectURL(d.photoUrl);
      d.photoUrl = URL.createObjectURL(d.photo); renderReport();
    } catch { toast("Не удалось прочитать фото, попробуйте другое."); }
  };
  document.querySelectorAll("[data-cat]").forEach(b => b.onclick = () => { keep(); d.cat = b.dataset.cat; renderReport(); });
  $("#pickBtn").onclick = () => { keep(); startPick(); };
  $("#sendBtn").onclick = e => { keep(); submitReport(e.currentTarget); };
}
function startPick(){
  const d = S.draft;
  $("#sheet").hidden = true; $("#sheetBackdrop").hidden = true;
  $("#addBtn").hidden = true; $("#locateBtn").hidden = true;
  if (d.lat) S.map.setView([d.lat, d.lng], Math.max(S.map.getZoom(), 17));
  $("#centerPin").hidden = false; $("#pickBar").hidden = false;
}
function endPick(){ $("#centerPin").hidden = true; $("#pickBar").hidden = true; $("#addBtn").hidden = false; $("#locateBtn").hidden = false; }
async function finishPick(){
  const c = S.map.getCenter(); endPick();
  Object.assign(S.draft, {lat:c.lat, lng:c.lng, address:"…", locating:false});
  renderReport();
  S.draft.address = await reverseGeocode(c.lat, c.lng);
  if ($("#rp")) renderReport();
}

// Пережимаем фото через canvas: уменьшаем до 1600 px и теряем все EXIF (GPS, модель телефона, время).
async function compressImage(file){
  const MAX = 1600;
  let src;
  try { src = await createImageBitmap(file, {imageOrientation:"from-image"}); }
  catch { src = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = URL.createObjectURL(file); }); }
  const w = src.width, h = src.height, k = Math.min(1, MAX / Math.max(w, h));
  const cv = document.createElement("canvas"); cv.width = Math.round(w*k); cv.height = Math.round(h*k);
  cv.getContext("2d").drawImage(src, 0, 0, cv.width, cv.height);
  return await new Promise((res, rej) => cv.toBlob(b => b ? res(b) : rej(new Error("toBlob")), "image/jpeg", 0.82));
}

async function submitReport(btn){
  const d = S.draft;
  if (!d.photo) return toast("Добавьте фото проблемы.");
  if (!d.lat) return toast("Отметьте место на карте.");
  if (!d.cat) return toast("Выберите, что случилось.");
  if (d.cat === "other" && !d.customType.trim()) return toast("Напишите, что за проблема.");
  // Дедупликация: та же категория ближе 120 м
  if (d.cat !== "other" && !d.skipDup){
    const dup = S.complaints.find(c => c.cat === d.cat && c.status !== "fixed" && !c.hidden && distM(c.lat, c.lng, d.lat, d.lng) <= DUP_RADIUS);
    if (dup) return offerDuplicate(dup);
  }
  await busy(btn, async () => {
    const uid = S.session.user.id;
    const path = `${uid}/${Date.now()}.jpg`;
    const up = await S.sb.storage.from("photos").upload(path, d.photo, {contentType:"image/jpeg", upsert:false});
    if (up.error) throw up.error;
    const { data, error } = await S.sb.rpc("create_complaint", {
      p_city:S.city, p_cat:d.cat, p_custom_type:d.cat==="other" ? d.customType.trim() : null,
      p_custom_sev:d.cat==="other" ? d.customSev : null, p_description:d.desc.trim() || null,
      p_address:d.address || null, p_lat:d.lat, p_lng:d.lng, p_photo_path:path,
    });
    if (error) throw error;
    S.draft = null;
    await Promise.all([loadMe(), loadComplaints()]);
    toast("Жалоба на карте. Спасибо!");
    openComplaint(data);
  });
}
function offerDuplicate(c){
  const dist = Math.round(distM(c.lat, c.lng, S.draft.lat, S.draft.lng));
  openSheet(`<h2>Похоже, об этом уже сообщили</h2>
    <p class="muted">В ${dist} м уже есть жалоба «${esc(catName(c))}». Лучше подтвердить её: так она быстрее уйдёт в акимат.</p>
    ${c.photo_path ? `<img class="photo" src="${photoUrl(c.photo_path)}" alt="">` : ""}
    <p class="small">${esc(c.address || "")} · ${plural(c.conf_count, "подтверждение", "подтверждения", "подтверждений")}</p>
    <div class="stack">
      <button class="btn" id="dupConfirm">${hasVote(c,"confirm") ? "Открыть существующую" : "Да, это она: подтвердить"}</button>
      <button class="btn ghost" id="dupNew">Нет, это другая проблема</button>
    </div>`);
  $("#dupConfirm").onclick = e => busy(e.currentTarget, async () => {
    if (!hasVote(c, "confirm")) await rpc("confirm_complaint", {p_id:c.id});
    S.draft = null; await refresh(); openComplaint(c.id);
  });
  $("#dupNew").onclick = () => { S.draft.skipDup = true; renderReport(); };
}

// ---------- Карточка жалобы ----------
async function rpc(fn, args){ const { data, error } = await S.sb.rpc(fn, args); if (error) throw error; return data; }
async function refresh(){ await Promise.all([loadMe(), loadComplaints()]); }

async function openComplaint(id){
  let c = S.byId.get(id);
  if (!c){ // точка из другого города или скрытая
    const { data } = await S.sb.from("complaints").select("*").eq("id", id).maybeSingle();
    if (!data){ toast("Жалоба не найдена или скрыта модератором."); return; }
    c = data;
    if (c.city !== S.city){ S.city = c.city; $("#city").value = c.city; localSet("qala.city", c.city); await loadComplaints(); }
  }
  if (location.hash !== "#c=" + id) history.replaceState(null, "", "#c=" + id);
  S.map.setView([c.lat, c.lng], Math.max(S.map.getZoom(), 16));
  renderComplaint(c);
}

function stepsHtml(c){
  const order = ["collecting","to_send","sent","in_work","verifying","fixed"];
  const i = order.indexOf(c.status);
  const label = {
    collecting: `Собираем подтверждения: ${Math.min(c.conf_count, SEND_MIN_CONF)}/${SEND_MIN_CONF}`,
    to_send: "Готово к отправке в eOtinish / iKomek",
    sent: c.ticket_no ? `Отправлено: № ${esc(c.ticket_no)}${c.sent_at ? ", " + fmtDate(c.sent_at) : ""}` : "Отправлено в акимат",
    in_work: c.answered_at ? `Акимат ответил ${fmtDate(c.answered_at)}` : "Акимат ответил, в работе",
    verifying: `Проверка ремонта: ${c.fixed_count}/${FIX_NEEDED} жителей`,
    fixed: c.fixed_at ? `Исправлено ${fmtDate(c.fixed_at)}` : "Исправлено",
  };
  return `<ul class="steps">${order.map((s, k) => `<li class="${k < i ? "done" : k === i ? (s === "fixed" ? "done" : "now") : ""}">${label[s]}</li>`).join("")}</ul>`;
}

function ticketTemplate(c){
  return `Прошу устранить проблему: ${catName(c)}.
Адрес: ${c.address || "см. координаты"} (координаты ${c.lat.toFixed(6)}, ${c.lng.toFixed(6)}; карта: https://www.openstreetmap.org/?mlat=${c.lat.toFixed(6)}&mlon=${c.lng.toFixed(6)}#map=18/${c.lat.toFixed(6)}/${c.lng.toFixed(6)}).
${c.description ? "Описание: " + c.description + "\n" : ""}Фото и подтверждения жителей (${c.conf_count}): ${appLink(c.id)}
Прошу сообщить срок устранения и ответственную организацию (подрядчика).`;
}

function renderComplaint(c){
  const col = colorOf(c), sev = sevOf(c), dUn = daysUnanswered(c);
  const member = !!S.profile && !S.profile.banned;
  const canConfirm = c.status !== "fixed" && !hasVote(c, "confirm");
  const canFix = ["sent","in_work","verifying"].includes(c.status) && !hasVote(c, "fixed");
  const canNotFix = c.status === "verifying" && !hasVote(c, "notfixed");
  const canBad = c.status === "fixed" && !hasVote(c, "bad");
  const needTicket = ["collecting","to_send"].includes(c.status) && (isMine(c) || isMod());

  let stat3;
  if (c.status === "sent") stat3 = `<div class="stat${dUn >= 15 ? " alert" : ""}"><b>${dUn}</b><span>дней без ответа</span></div>`;
  else if (c.status === "in_work") stat3 = `<div class="stat"><b>${daysSince(c.answered_at)}</b><span>дней в работе</span></div>`;
  else if (c.status === "verifying") stat3 = `<div class="stat"><b>${c.fixed_count}/${FIX_NEEDED}</b><span>«исправлено»</span></div>`;
  else if (c.status === "fixed") stat3 = `<div class="stat"><b>✓</b><span>проверено жителями</span></div>`;
  else stat3 = `<div class="stat"><b>${daysSince(c.created_at)}</b><span>дней на карте</span></div>`;

  const actions = [];
  if (canConfirm) actions.push(`<button class="btn" data-act="confirm">У меня тоже / вижу это</button>`);
  else if (hasVote(c,"confirm") && c.status !== "fixed") actions.push(`<div class="muted small">Вы подтвердили эту проблему.</div>`);
  if (canFix) actions.push(`<button class="btn light" data-act="fixed">Уже исправили</button>`);
  if (canNotFix) actions.push(`<button class="btn ghost" data-act="notfixed">Не исправлено</button>`);
  if (canBad) actions.push(`<button class="btn ghost" data-act="bad">Сделано плохо / снова сломалось${c.bad_count ? ` (${c.bad_count}/${REOPEN_NEEDED})` : ""}</button>`);
  if (["fixed","notfixed","bad"].some(k => hasVote(c,k)) && !canFix && !canNotFix && !canBad && c.status !== "collecting" && c.status !== "to_send")
    actions.push(`<div class="muted small">Ваш голос о ремонте учтён.</div>`);

  openSheet(`
    <div class="row wrap"><span class="badge ${col}">${COLOR_NAME[col]}</span><span class="pill">${SEV[sev]}</span>${c.reopen_count ? `<span class="pill">открыта повторно ×${c.reopen_count}</span>` : ""}${isMine(c) ? `<span class="pill">моя жалоба</span>` : ""}${c.hidden ? `<span class="pill">скрыта: ${esc(c.hidden_reason || "")}</span>` : ""}</div>
    <h2>${esc(catName(c))}</h2>
    <div class="muted small">${esc(c.address || `${c.lat.toFixed(5)}, ${c.lng.toFixed(5)}`)} · добавлено ${fmtDate(c.created_at)}</div>
    ${c.photo_path ? `<img class="photo" style="margin-top:10px" src="${photoUrl(c.photo_path)}" alt="Фото проблемы" loading="lazy">` : ""}
    ${c.description ? `<p>${esc(c.description)}</p>` : ""}
    ${c.bad_photo_path ? `<h3>${c.status === "fixed" ? "Житель сообщает: сделано плохо" : "Фото, по которому точку открыли повторно"}</h3><img class="photo" src="${photoUrl(c.bad_photo_path)}" alt="Фото после ремонта" loading="lazy">` : ""}
    <div class="stats">
      <div class="stat"><b>${c.conf_count}</b><span>жителей подтвердили</span></div>
      <div class="stat"><b>${STATUS_SHORT(c)}</b><span>статус</span></div>
      ${stat3}
    </div>
    ${stepsHtml(c)}
    ${c.contractor || c.warranty_until ? `<div class="box small">${c.contractor ? "Подрядчик: <b>" + esc(c.contractor) + "</b>. " : ""}${c.warranty_until ? "Гарантия до " + fmtDate(c.warranty_until) : ""}</div>` : ""}
    <div class="stack" style="margin-top:12px">${actions.join("")}
      ${(canFix || canNotFix || canBad) ? `<div class="muted small">Голос о ремонте принимается только рядом с точкой (до ${GEO_RADIUS} м): телефон спросит геолокацию.</div>` : ""}
    </div>
    ${needTicket ? ticketBlock(c) : ""}
    ${c.status === "to_send" && !needTicket ? `<div class="box info small" style="margin-top:12px">Жалоба в очереди: модератор подаст её в eOtinish / iKomek 109 и впишет номер обращения. Можно подать и самому: <a href="#" id="selfFile">как подать</a>.</div>` : ""}
    <div class="row" style="margin-top:14px"><button class="btn ghost sm" id="shareBtn">Поделиться</button><button class="btn ghost sm" data-close>Закрыть</button></div>
    ${isMod() ? modBlock(c) : ""}
  `);

  document.querySelectorAll("[data-act]").forEach(b => b.onclick = e => {
    if (!member && !ensureMember(() => openComplaint(c.id))) return;
    const act = b.dataset.act;
    if (act === "bad") return badRepairFlow(c);
    busy(e.currentTarget, async () => {
      if (act === "confirm"){ await rpc("confirm_complaint", {p_id:c.id}); toast("Подтверждение учтено."); }
      else {
        const p = await getPosition();
        const st = await rpc("vote_repair", {p_id:c.id, p_kind:act, p_lat:p.lat, p_lng:p.lng});
        toast(st === "fixed" ? "Три жителя подтвердили ремонт: точка зелёная!" : st === "to_send" ? "Точка открыта повторно." : "Голос учтён.");
      }
      await refresh(); openComplaint(c.id);
    });
  });
  $("#shareBtn").onclick = async () => {
    const url = appLink(c.id), text = `${catName(c)}: ${c.address || ""} — подтвердите на карте Qala.fix`;
    try { if (navigator.share) await navigator.share({title:"Qala.fix", text, url}); else { await navigator.clipboard.writeText(url); toast("Ссылка скопирована."); } } catch {}
  };
  if ($("#selfFile")) $("#selfFile").onclick = e => { e.preventDefault(); $("#selfFile").closest(".box").outerHTML = ticketBlock(c, true); bindTicket(c); };
  bindTicket(c);
  if (isMod()) bindMod(c);
}
// «Сделано плохо / снова сломалось»: только со свежим фото и геометкой ≤150 м
function badRepairFlow(c){
  let photo = null, url = null;
  const draw = () => {
    openSheet(`<h2>Сделано плохо / снова сломалось</h2>
      <p class="muted small">Сфотографируйте место сейчас. Голос примем, только если вы рядом с точкой (до ${GEO_RADIUS} м). После ${REOPEN_NEEDED} таких голосов точка снова станет открытой и уйдёт в акимат повторно, со ссылкой на гарантию подрядчика.</p>
      <div class="stack">
        <label class="photo-pick">${url ? `<img src="${url}" alt="">` : `<div style="font-size:30px">📷</div><div><b>Сделать фото сейчас</b></div>`}
          <input type="file" id="badPhoto" accept="image/*" capture="environment"></label>
        <button class="btn" id="badSend"${photo ? "" : " disabled"}>Отправить голос</button>
        <button class="btn ghost" id="badBack">Назад</button>
      </div>`);
    $("#badPhoto").onchange = async e => {
      const f = e.target.files[0]; if (!f) return;
      try { photo = await compressImage(f); if (url) URL.revokeObjectURL(url); url = URL.createObjectURL(photo); draw(); }
      catch { toast("Не удалось прочитать фото, попробуйте другое."); }
    };
    $("#badBack").onclick = () => openComplaint(c.id);
    $("#badSend").onclick = e => busy(e.currentTarget, async () => {
      const p = await getPosition();
      if (distM(c.lat, c.lng, p.lat, p.lng) > GEO_RADIUS) throw new Error("too_far:" + Math.round(distM(c.lat, c.lng, p.lat, p.lng)));
      const path = `${S.session.user.id}/bad-${c.id}-${Date.now()}.jpg`;
      const up = await S.sb.storage.from("photos").upload(path, photo, {contentType:"image/jpeg", upsert:false});
      if (up.error) throw up.error;
      const st = await rpc("vote_repair", {p_id:c.id, p_kind:"bad", p_lat:p.lat, p_lng:p.lng, p_photo_path:path});
      toast(st === "to_send" ? "Точка открыта повторно и снова уйдёт в акимат." : "Голос с фото учтён.");
      await refresh(); openComplaint(c.id);
    });
  };
  draw();
}
function STATUS_SHORT(c){ return ({collecting:"сбор", to_send:"в очереди", sent:"отправлено", in_work:"в работе", verifying:"проверка", fixed:"готово"})[c.status]; }

function ticketBlock(c, readOnly){
  return `<div class="box warn" style="margin-top:14px" id="ticketBox">
    <b>Подать обращение в акимат</b>
    <ol class="small" style="padding-left:18px;margin:8px 0">
      <li>Скопируйте текст ниже.</li>
      <li>Подайте на <a href="https://eotinish.kz" target="_blank" rel="noopener">eotinish.kz</a> (вход через eGov) или позвоните в <a href="tel:109">iKomek 109</a>.</li>
      <li>${readOnly ? "Номер обращения пришлите модератору, он впишет его сюда." : "Впишите сюда номер обращения: с этого дня пойдёт счётчик «дней без ответа»."}</li>
    </ol>
    <div class="tpl" id="tpl">${esc(ticketTemplate(c))}</div>
    <div class="row" style="margin-top:8px"><button class="btn sm light" id="copyTpl">Скопировать текст</button></div>
    ${readOnly ? "" : `<div class="row" style="margin-top:10px">
      <select id="tChan" style="border:1.5px solid var(--line);border-radius:10px;padding:8px"><option value="eotinish">eOtinish</option><option value="ikomek">iKomek 109</option><option value="other">Другое</option></select>
      <input id="tNo" placeholder="Номер обращения" style="flex:1;min-width:0;border:1.5px solid var(--line);border-radius:10px;padding:8px">
      <button class="btn sm" id="tSave">OK</button></div>`}
  </div>`;
}
function bindTicket(c){
  if ($("#copyTpl")) $("#copyTpl").onclick = async () => {
    try { await navigator.clipboard.writeText(ticketTemplate(c)); toast("Текст скопирован."); }
    catch { const r = document.createRange(); r.selectNodeContents($("#tpl")); getSelection().removeAllRanges(); getSelection().addRange(r); toast("Выделено: нажмите «Копировать»."); }
  };
  if ($("#tSave")) $("#tSave").onclick = e => busy(e.currentTarget, async () => {
    await rpc("set_ticket", {p_id:c.id, p_channel:$("#tChan").value, p_no:$("#tNo").value});
    toast("Номер сохранён, счётчик дней без ответа запущен."); await refresh(); openComplaint(c.id);
  });
}

// ---------- Модератор ----------
function modBlock(c){
  const catOpts = Object.entries(CATS).filter(([k]) => k !== "other").map(([k,v]) => `<option value="${k}">${esc(v.name)}</option>`).join("");
  return `<div class="box" style="margin-top:16px"><b>Модератор</b>
    <div class="row wrap" style="margin-top:8px">
      ${["sent","to_send"].includes(c.status) ? `<button class="btn sm" data-mod="answered">Акимат ответил</button>` : ""}
      ${["sent","in_work"].includes(c.status) ? `<button class="btn sm" data-mod="akimat_reported">Акимат отчитался о ремонте</button>` : ""}
      ${c.hidden ? `<button class="btn sm light" data-mod="unhide">Вернуть на карту</button>` : `<button class="btn sm warn" data-mod="hide">Скрыть</button>`}
      ${c.photo_path ? `<button class="btn sm ghost" data-mod="remove_photo">Убрать фото</button>` : ""}
      <button class="btn sm warn" data-mod="ban_author">Бан автора</button>
    </div>
    ${c.cat === "other" && !c.moderated ? `<div class="row wrap" style="margin-top:8px">
      <select id="mSev" style="padding:6px;border-radius:8px">${[3,2,1].map(s => `<option value="${s}"${c.custom_sev==s?" selected":""}>${SEV[s]}</option>`).join("")}</select>
      <button class="btn sm" data-mod="approve_custom">Подтвердить уровень</button></div>
      <div class="row wrap" style="margin-top:8px"><select id="mCat" style="padding:6px;border-radius:8px;max-width:60%">${catOpts}</select><button class="btn sm light" data-mod="set_cat">Перенести в категорию</button></div>` : ""}
    ${["sent","in_work","verifying","fixed"].includes(c.status) ? `<div class="row" style="margin-top:8px"><input id="mContr" placeholder="Подрядчик" value="${esc(c.contractor||"")}" style="flex:1;min-width:0;padding:6px;border:1px solid var(--line);border-radius:8px"><button class="btn sm ghost" data-mod="contractor">OK</button></div>
      <div class="row" style="margin-top:6px"><input id="mWarr" type="date" value="${c.warranty_until||""}" style="flex:1;padding:6px;border:1px solid var(--line);border-radius:8px"><button class="btn sm ghost" data-mod="warranty">Гарантия до</button></div>` : ""}
  </div>`;
}
function bindMod(c){
  document.querySelectorAll("[data-mod]").forEach(b => b.onclick = e => {
    const a = b.dataset.mod; let v = null;
    if (a === "hide" || a === "ban_author"){ v = prompt(a === "hide" ? "Причина (видна автору):" : "Причина бана:", a === "hide" ? "дубль" : "спам"); if (v === null) return; }
    if (a === "approve_custom") v = $("#mSev").value;
    if (a === "set_cat") v = $("#mCat").value;
    if (a === "contractor") v = $("#mContr").value;
    if (a === "warranty"){ v = $("#mWarr").value; if (!v) return toast("Выберите дату."); }
    busy(e.currentTarget, async () => { await rpc("mod_action", {p_id:c.id, p_action:a, p_value:v}); toast("Сделано."); await refresh(); openComplaint(c.id); });
  });
}
async function openModeration(){
  const { data, error } = await S.sb.from("complaints").select("*").order("created_at", {ascending:false}).limit(1000);
  if (error) return toast(errText(error));
  const item = c => `<div class="list-item" data-open="${c.id}"><i class="dot ${colorOf(c)}"></i><div class="grow"><div class="title">${esc(catName(c))}</div>
    <div class="muted small">${esc(CITIES[c.city]?.name || c.city)} · ${esc(c.address || "")} · ${plural(c.conf_count,"подтв.","подтв.","подтв.")}${c.status==="sent" ? ` · <b>${daysUnanswered(c)} дн. без ответа</b>` : ""}</div></div></div>`;
  const sect = (title, arr, hint) => `<h3>${title} (${arr.length})</h3>${hint ? `<div class="muted small">${hint}</div>` : ""}${arr.map(item).join("") || `<div class="muted small">Пусто</div>`}`;
  const all = data || [];
  openSheet(`<h2>Модерация</h2>
    ${sect("Подать в акимат", all.filter(c => c.status === "to_send" && !c.hidden), "Откройте точку, скопируйте текст, подайте в eOtinish / iKomek и впишите номер.")}
    ${sect("«Другое» ждёт проверки", all.filter(c => c.cat === "other" && !c.moderated && !c.hidden))}
    ${sect("Ждут ответа акимата", all.filter(c => c.status === "sent" && !c.hidden).sort((a,b) => daysUnanswered(b) - daysUnanswered(a)), "Когда придёт ответ, отметьте «Акимат ответил».")}
    ${sect("В работе", all.filter(c => c.status === "in_work" && !c.hidden))}
    ${sect("Скрытые", all.filter(c => c.hidden))}
    <h3>Всего: ${all.length}</h3>`);
  document.querySelectorAll("[data-open]").forEach(el => el.onclick = () => openComplaint(Number(el.dataset.open)));
}

// ---------- Меню ----------
function openMenu(){
  const mine = S.complaints.filter(isMine);
  openSheet(`<h2>Qala.fix</h2>
    <p class="muted small">Пилот для жителей ${({astana:"Астаны",almaty:"Алматы"})[S.city]}. Жалоба с фото попадает на общую карту, жители подтверждают её, а мы считаем, сколько дней акимат не отвечает. Зелёной точка становится, только когда 3 жителя на месте подтвердили ремонт.</p>
    ${isMod() ? `<button class="btn" id="modBtn" style="width:100%;margin:6px 0">Модерация</button>` : ""}
    ${S.profile ? "" : `<button class="btn" id="joinMenu" style="width:100%;margin:6px 0">Войти по инвайт-коду</button>`}
    <h3>Цвета</h3>
    <div class="legend">
      <div><i class="dot red"></i> Опасно для жизни, или много подтверждений и долго без ответа</div>
      <div><i class="dot orange"></i> Срочно</div>
      <div><i class="dot yellow"></i> Неудобство</div>
      <div><i class="dot green"></i> Исправлено: 3 жителя проверили на месте</div>
      <div><span class="marker yellow collecting" style="display:inline-block;width:14px;height:14px;border-width:2px;border-color:#888"></span> Пунктир: ещё собираем подтверждения</div>
    </div>
    <h3>Мои жалобы (${mine.length})</h3>
    ${mine.map(c => `<div class="list-item" data-open="${c.id}"><i class="dot ${colorOf(c)}"></i><div class="grow"><div class="title">${esc(catName(c))}</div><div class="muted small">${STATUS[c.status]}</div></div></div>`).join("") || `<div class="muted small">Пока нет.</div>`}
    <h3>Установить на телефон</h3>
    <div class="muted small">iPhone: Safari → «Поделиться» → «На экран Домой». Android: Chrome → ⋮ → «Добавить на главный экран».</div>
    <h3>Данные</h3>
    <div class="muted small">Мы не собираем имя и телефон. <a href="privacy.html" target="_blank">Условия пилота и обработка данных</a>.</div>
    ${S.profile ? `<button class="btn ghost" id="delMe" style="width:100%;margin-top:10px">Удалить мои жалобы и аккаунт</button>` : ""}
    <p class="muted small" style="margin-top:16px">Карта © участники OpenStreetMap.</p>`);
  document.querySelectorAll("[data-open]").forEach(el => el.onclick = () => openComplaint(Number(el.dataset.open)));
  if ($("#modBtn")) $("#modBtn").onclick = openModeration;
  if ($("#joinMenu")) $("#joinMenu").onclick = () => openJoin();
  if ($("#delMe")) $("#delMe").onclick = e => {
    if (!confirm("Удалить все ваши жалобы, фото и голоса? Это нельзя отменить.")) return;
    busy(e.currentTarget, async () => {
      const uid = S.session.user.id;
      const { data: files } = await S.sb.storage.from("photos").list(uid, {limit:1000});
      if (files?.length) await S.sb.storage.from("photos").remove(files.map(f => `${uid}/${f.name}`));
      await rpc("delete_my_data", {});
      await S.sb.auth.signOut();
      S.session = null; await refresh(); closeSheet(); toast("Ваши данные удалены.");
    });
  };
}

init().catch(e => { console.error(e); toast(errText(e), 6000); });
