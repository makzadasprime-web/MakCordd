/* =============================================================================
   MAKCORD
   Chat e chamadas (áudio/vídeo, inclusive em grupo até 6 pessoas) entre amigos,
   100% no navegador — sem backend próprio. Usa PeerJS (WebRTC) para conexão
   direta entre pares; o único servidor externo é o broker público de sinalização
   do PeerJS, usado apenas para os dois lados se "encontrarem".

   Cada nome de usuário vira um ID de par determinístico ("makcord-<nome>"),
   é assim que "adicionar amigo por nome" funciona sem precisar de um diretório
   central. Ver README.md para as limitações desse modelo.
   ============================================================================= */

const PREFIX = 'makcord-';
const MAX_ROOM_SIZE = 6;

/* ---------------------------------------------------------------------------
   Estado
   ------------------------------------------------------------------------- */
let myUsername = null;
let myPeerId = null;
let peer = null;

let friends = [];                 // nomes de exibição
let dataConns = {};                // peerId -> DataConnection
let friendStatus = {};             // peerId -> 'online' | 'offline'

let activeChatFriend = null;       // nome do amigo com o chat aberto

let currentCall = null;            // MediaConnection ativa (1:1)
let localStream1to1 = null;
let incomingCallPending = null;    // { call, name }

let room = {
  active: false, isHost: false, hostPeerId: null,
  members: [],                     // [{id, name}]
  localStream: null,
  mediaCalls: {},                  // peerId -> MediaConnection
  remoteStreams: {}                // peerId -> MediaStream
};

/* ---------------------------------------------------------------------------
   Utilidades
   ------------------------------------------------------------------------- */
function sanitize(name){
  return (name || '')
    .trim().toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '');
}
function peerIdFor(name){ return PREFIX + sanitize(name); }
function initials(name){
  const s = sanitize(name);
  return s ? s.slice(0, 2) : '?';
}
function friendNameForPeerId(peerId){
  const f = friends.find(f => peerIdFor(f) === peerId);
  if (f) return f;
  const m = room.members.find(m => m.id === peerId);
  return m ? m.name : null;
}
function el(id){ return document.getElementById(id); }
function fmtTime(ts){
  return new Date(ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

function toast(message, type){
  const t = document.createElement('div');
  t.className = 'toast' + (type ? ' ' + type : '');
  t.textContent = message;
  el('toast-container').appendChild(t);
  setTimeout(() => t.remove(), 4000);
}

/* ---------------------------------------------------------------------------
   Armazenamento local (por usuário, só neste navegador)
   ------------------------------------------------------------------------- */
function friendsKey(){ return 'makcord.friends.' + sanitize(myUsername); }
function chatKey(friendName){ return 'makcord.chat.' + sanitize(myUsername) + '.' + sanitize(friendName); }

function loadFriends(){
  try { friends = JSON.parse(localStorage.getItem(friendsKey())) || []; }
  catch(e){ friends = []; }
}
function saveFriends(){ localStorage.setItem(friendsKey(), JSON.stringify(friends)); }

function loadMessages(friendName){
  try { return JSON.parse(localStorage.getItem(chatKey(friendName))) || []; }
  catch(e){ return []; }
}
function saveMessage(friendName, msg){
  const list = loadMessages(friendName);
  list.push(msg);
  if (list.length > 300) list.splice(0, list.length - 300);
  localStorage.setItem(chatKey(friendName), JSON.stringify(list));
}

/* =============================================================================
   INICIALIZAÇÃO
   ============================================================================= */
document.addEventListener('DOMContentLoaded', () => {
  bindUI();
  const saved = localStorage.getItem('makcord.username');
  if (saved){
    el('username-input').value = saved;
    startApp(saved);
  }
});

function bindUI(){
  el('login-form').addEventListener('submit', e => {
    e.preventDefault();
    const name = el('username-input').value;
    if (!sanitize(name)){
      el('login-hint').textContent = 'Use letras ou números, sem espaços especiais.';
      el('login-hint').className = 'field-hint error';
      return;
    }
    startApp(name.trim());
  });

  el('add-friend-form').addEventListener('submit', e => {
    e.preventDefault();
    const input = el('add-friend-input');
    addFriend(input.value);
    input.value = '';
  });

  el('join-room-form').addEventListener('submit', e => {
    e.preventDefault();
    const input = el('join-room-input');
    if (sanitize(input.value)) joinRoom(input.value.trim());
    input.value = '';
  });

  el('btn-create-room').addEventListener('click', createRoom);
  el('btn-leave-room').addEventListener('click', () => leaveRoom());

  el('message-form').addEventListener('submit', e => {
    e.preventDefault();
    const input = el('message-input');
    sendMessage(input.value);
    input.value = '';
  });

  el('btn-call-audio').addEventListener('click', () => startCall(false));
  el('btn-call-video').addEventListener('click', () => startCall(true));

  el('call-btn-hangup').addEventListener('click', endCall);
  el('call-btn-mic').addEventListener('click', () => toggleTrack(localStream1to1, 'audio', 'call-btn-mic'));
  el('call-btn-cam').addEventListener('click', () => toggleTrack(localStream1to1, 'video', 'call-btn-cam'));

  el('btn-accept').addEventListener('click', acceptIncomingCall);
  el('btn-decline').addEventListener('click', declineIncomingCall);

  el('btn-toggle-mic').addEventListener('click', () => toggleTrack(room.localStream, 'audio', 'btn-toggle-mic'));
  el('btn-toggle-cam').addEventListener('click', () => toggleTrack(room.localStream, 'video', 'btn-toggle-cam'));
}

function startApp(name){
  myUsername = name;
  localStorage.setItem('makcord.username', name);

  el('screen-login').classList.add('hidden');
  el('screen-app').classList.remove('hidden');

  el('me-name').textContent = myUsername;
  el('me-avatar').textContent = initials(myUsername);

  loadFriends();
  renderFriends();
  initPeer();

  setInterval(refreshFriendStatuses, 25000);
}

/* =============================================================================
   PEER.JS — conexão e sinalização
   ============================================================================= */
function initPeer(){
  myPeerId = peerIdFor(myUsername);
  setMyStatus('connecting');

  peer = new Peer(myPeerId, { debug: 1 });

  peer.on('open', () => {
    setMyStatus('online');
    friends.forEach(f => getOrCreateDataConn(peerIdFor(f), f));
  });

  peer.on('connection', conn => handleIncomingDataConnection(conn));
  peer.on('call', call => handleIncomingCall(call));

  peer.on('disconnected', () => {
    setMyStatus('offline');
    try { peer.reconnect(); } catch(e){}
  });

  peer.on('error', err => handlePeerError(err));
}

function handlePeerError(err){
  if (err.type === 'unavailable-id'){
    toast('Esse nome já está em uso por outra pessoa. Escolha outro.', 'error');
    localStorage.removeItem('makcord.username');
    el('screen-app').classList.add('hidden');
    el('screen-login').classList.remove('hidden');
    return;
  }
  if (err.type === 'peer-unavailable'){
    const match = /peer\s+(\S+)/i.exec(err.message || '');
    const id = match ? match[1] : null;
    if (id){
      setFriendStatus(id, 'offline');
      delete dataConns[id];
    }
    return;
  }
  console.warn('Peer error:', err);
}

function setMyStatus(status){
  const dot = el('me-status-dot');
  dot.className = 'status-dot ' + (status === 'online' ? 'online' : '');
  el('me-status-text').textContent =
    status === 'online' ? 'online' : status === 'connecting' ? 'conectando…' : 'offline';
}

/* ---------------------------------------------------------------------------
   Conexões de dados (chat + sinalização de sala)
   ------------------------------------------------------------------------- */
function getOrCreateDataConn(peerId, displayName){
  if (dataConns[peerId]) return dataConns[peerId];
  const conn = peer.connect(peerId, { metadata: { name: myUsername }, reliable: true });
  wireDataConn(conn);
  dataConns[peerId] = conn;
  return conn;
}

function wireDataConn(conn){
  conn.on('open', () => setFriendStatus(conn.peer, 'online'));
  conn.on('data', data => handleData(conn, data));
  conn.on('close', () => { setFriendStatus(conn.peer, 'offline'); delete dataConns[conn.peer]; });
  conn.on('error', () => { setFriendStatus(conn.peer, 'offline'); delete dataConns[conn.peer]; });
}

function handleIncomingDataConnection(conn){
  wireDataConn(conn);
  dataConns[conn.peer] = conn;

  const name = conn.metadata && conn.metadata.name;
  if (name && sanitize(name) !== sanitize(myUsername) && !friends.some(f => sanitize(f) === sanitize(name))){
    friends.push(name);
    saveFriends();
    renderFriends();
    toast('Novo contato: ' + name, 'ok');
  }
}

function handleData(conn, data){
  if (!data || !data.type) return;

  if (data.type === 'chat'){
    const name = friendNameForPeerId(conn.peer) || (conn.metadata && conn.metadata.name) || 'desconhecido';
    saveMessage(name, { dir: 'in', text: data.text, ts: data.ts || Date.now() });
    if (activeChatFriend === name) renderMessages(name);
    else toast(name + ': ' + String(data.text).slice(0, 48));
    return;
  }
  if (data.type === 'join-room'){
    if (room.active && room.isHost) hostAddMember(conn.peer, data.name);
    return;
  }
  if (data.type === 'roster'){
    applyRoster(data.members);
    return;
  }
  if (data.type === 'room-full'){
    toast('A sala já está com 6 pessoas — o máximo permitido.', 'error');
    leaveRoom(true);
    return;
  }
  if (data.type === 'room-closed'){
    if (room.active) { leaveRoom(true); toast('O anfitrião encerrou a sala.'); }
    return;
  }
  if (data.type === 'left-room'){
    if (room.active && room.isHost) hostRemoveMember(conn.peer);
    return;
  }
}

/* ---------------------------------------------------------------------------
   Status de presença
   ------------------------------------------------------------------------- */
function setFriendStatus(peerId, status){
  friendStatus[peerId] = status;

  const li = document.querySelector('.friend-item[data-peer="' + peerId + '"]');
  if (li){
    const dot = li.querySelector('.status-dot');
    dot.className = 'status-dot ' + status;
  }
  if (activeChatFriend && peerIdFor(activeChatFriend) === peerId){
    el('chat-status-dot').className = 'status-dot ' + status;
    el('chat-status-text').textContent = status === 'online' ? 'online' : 'offline';
  }
}

function refreshFriendStatuses(){
  friends.forEach(f => {
    const id = peerIdFor(f);
    const conn = dataConns[id];
    if (!conn || conn.open === false) getOrCreateDataConn(id, f);
  });
}

/* =============================================================================
   AMIGOS
   ============================================================================= */
function addFriend(rawName){
  const hint = el('add-friend-hint');
  const name = (rawName || '').trim();
  hint.className = 'field-hint';

  if (!sanitize(name)){ hint.textContent = 'Digite um nome válido.'; hint.classList.add('error'); return; }
  if (sanitize(name) === sanitize(myUsername)){ hint.textContent = 'Esse nome é o seu.'; hint.classList.add('error'); return; }
  if (friends.some(f => sanitize(f) === sanitize(name))){ hint.textContent = 'Já está na sua lista.'; hint.classList.add('error'); return; }

  friends.push(name);
  saveFriends();
  renderFriends();
  getOrCreateDataConn(peerIdFor(name), name);
  hint.textContent = name + ' adicionado.';
  hint.classList.add('ok');
}

function removeFriend(name){
  friends = friends.filter(f => f !== name);
  saveFriends();
  if (activeChatFriend === name){
    activeChatFriend = null;
    el('panel-chat').classList.add('hidden');
    el('panel-empty').classList.remove('hidden');
  }
  renderFriends();
}

function renderFriends(){
  const list = el('friends-list');
  list.innerHTML = '';
  friends.forEach(name => {
    const peerId = peerIdFor(name);
    const li = document.createElement('li');
    li.className = 'friend-item' + (activeChatFriend === name ? ' active' : '');
    li.dataset.peer = peerId;
    li.innerHTML =
      '<div class="avatar">' + initials(name) + '</div>' +
      '<span class="friend-name">' + escapeHtml(name) + '</span>' +
      '<span class="status-dot ' + (friendStatus[peerId] || '') + '"></span>' +
      '<button class="btn btn-ghost btn-icon friend-remove" title="Remover" aria-label="Remover amigo" style="width:26px;height:26px;font-size:13px;">×</button>';
    li.addEventListener('click', () => openChat(name));
    li.querySelector('.friend-remove').addEventListener('click', e => { e.stopPropagation(); removeFriend(name); });
    list.appendChild(li);
  });
  el('friends-empty').classList.toggle('hidden', friends.length > 0);
}

function escapeHtml(s){
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

/* =============================================================================
   CHAT 1:1
   ============================================================================= */
function openChat(name){
  if (room.active){ toast('Saia da sala em grupo para abrir um chat.', 'error'); return; }

  activeChatFriend = name;
  el('panel-empty').classList.add('hidden');
  el('panel-room').classList.add('hidden');
  el('panel-chat').classList.remove('hidden');

  el('chat-name').textContent = name;
  el('chat-avatar').textContent = initials(name);

  const peerId = peerIdFor(name);
  el('chat-status-dot').className = 'status-dot ' + (friendStatus[peerId] || '');
  el('chat-status-text').textContent = friendStatus[peerId] === 'online' ? 'online' : 'offline';

  getOrCreateDataConn(peerId, name);
  renderMessages(name);
  renderFriends();
}

function renderMessages(name){
  const box = el('messages');
  box.innerHTML = '';
  loadMessages(name).forEach(m => {
    const div = document.createElement('div');
    div.className = 'msg ' + (m.dir === 'out' ? 'msg-me' : 'msg-them');
    div.innerHTML = escapeHtml(m.text) + '<div class="msg-time">' + fmtTime(m.ts) + '</div>';
    box.appendChild(div);
  });
  box.scrollTop = box.scrollHeight;
}

function sendMessage(text){
  text = (text || '').trim();
  if (!text || !activeChatFriend) return;

  const peerId = peerIdFor(activeChatFriend);
  const conn = getOrCreateDataConn(peerId, activeChatFriend);
  const msg = { dir: 'out', text, ts: Date.now() };
  saveMessage(activeChatFriend, msg);
  renderMessages(activeChatFriend);

  const payload = { type: 'chat', text: msg.text, ts: msg.ts };
  if (conn.open){
    conn.send(payload);
  } else {
    const friendName = activeChatFriend;
    const warnTimer = setTimeout(() => toast(friendName + ' está offline — a mensagem ficou salva só aqui.', 'error'), 4000);
    conn.on('open', () => { clearTimeout(warnTimer); conn.send(payload); });
  }
}

/* =============================================================================
   CHAMADAS 1:1 (áudio / vídeo)
   ============================================================================= */
function startCall(video){
  if (!activeChatFriend) return;
  if (currentCall){ toast('Você já está em uma chamada.', 'error'); return; }

  const peerId = peerIdFor(activeChatFriend);
  navigator.mediaDevices.getUserMedia({ audio: true, video })
    .then(stream => {
      localStream1to1 = stream;
      showCallOverlay(activeChatFriend);
      el('call-status-text').textContent = 'chamando…';
      const call = peer.call(peerId, stream, { metadata: { name: myUsername } });
      currentCall = call;
      wireMediaCall(call);
    })
    .catch(() => toast('Não foi possível acessar câmera/microfone.', 'error'));
}

function wireMediaCall(call){
  call.on('stream', remoteStream => {
    el('call-remote-video').srcObject = remoteStream;
    el('call-remote-fallback').classList.add('hidden');
  });
  call.on('close', endCall);
  call.on('error', endCall);
}

function handleIncomingCall(call){
  if (room.active){
    if (room.members.some(m => m.id === call.peer)){
      call.answer(room.localStream);
      wireRoomMediaCall(call);
    } else {
      call.close();
    }
    return;
  }
  if (currentCall || incomingCallPending){ call.close(); return; }

  const name = (call.metadata && call.metadata.name) || friendNameForPeerId(call.peer) || 'alguém';
  incomingCallPending = { call, name };
  el('incoming-avatar').textContent = initials(name);
  el('incoming-name').textContent = name;
  el('incoming-overlay').classList.remove('hidden');
}

function acceptIncomingCall(){
  if (!incomingCallPending) return;
  const { call, name } = incomingCallPending;
  navigator.mediaDevices.getUserMedia({ audio: true, video: true })
    .then(stream => {
      localStream1to1 = stream;
      currentCall = call;
      call.answer(stream);
      wireMediaCall(call);
      showCallOverlay(name);
      el('incoming-overlay').classList.add('hidden');
      incomingCallPending = null;
    })
    .catch(() => {
      toast('Não foi possível acessar câmera/microfone.', 'error');
      call.close();
      el('incoming-overlay').classList.add('hidden');
      incomingCallPending = null;
    });
}

function declineIncomingCall(){
  if (!incomingCallPending) return;
  incomingCallPending.call.close();
  incomingCallPending = null;
  el('incoming-overlay').classList.add('hidden');
}

function showCallOverlay(name){
  el('call-remote-name').textContent = name;
  el('call-remote-avatar').textContent = initials(name);
  el('call-remote-fallback').classList.remove('hidden');
  el('call-remote-video').srcObject = null;
  el('call-local-video').srcObject = localStream1to1;
  el('call-overlay').classList.remove('hidden');
}

function endCall(){
  if (currentCall){ try { currentCall.close(); } catch(e){} }
  if (localStream1to1){ localStream1to1.getTracks().forEach(t => t.stop()); localStream1to1 = null; }
  currentCall = null;
  el('call-overlay').classList.add('hidden');
  el('call-remote-video').srcObject = null;
  el('call-local-video').srcObject = null;
}

function toggleTrack(stream, kind, buttonId){
  if (!stream) return;
  const tracks = kind === 'audio' ? stream.getAudioTracks() : stream.getVideoTracks();
  if (!tracks.length) return;
  const enabled = !tracks[0].enabled;
  tracks.forEach(t => t.enabled = enabled);
  el(buttonId).style.opacity = enabled ? '1' : '0.45';
}

/* =============================================================================
   SALA EM GRUPO (até 6 pessoas, malha P2P)

   O anfitrião funciona só como "quadro de avisos": ele recebe pedidos de
   entrada, mantém a lista de participantes e a retransmite para todo mundo.
   A partir daí, cada participante liga diretamente para os outros — o áudio
   e vídeo nunca passam pelo anfitrião.
   ============================================================================= */
function createRoom(){
  if (room.active){ toast('Você já está em uma sala.', 'error'); return; }
  navigator.mediaDevices.getUserMedia({ audio: true, video: true })
    .then(stream => {
      room = {
        active: true, isHost: true, hostPeerId: myPeerId,
        members: [{ id: myPeerId, name: myUsername }],
        localStream: stream, mediaCalls: {}, remoteStreams: {}
      };
      openRoomPanel();
    })
    .catch(() => toast('Não foi possível acessar câmera/microfone.', 'error'));
}

function joinRoom(hostName){
  if (room.active){ toast('Você já está em uma sala.', 'error'); return; }
  const hostPeerId = peerIdFor(hostName);
  if (hostPeerId === myPeerId){ toast('Esse nome é o seu.', 'error'); return; }

  navigator.mediaDevices.getUserMedia({ audio: true, video: true })
    .then(stream => {
      room = {
        active: true, isHost: false, hostPeerId,
        members: [{ id: myPeerId, name: myUsername }],
        localStream: stream, mediaCalls: {}, remoteStreams: {}
      };
      openRoomPanel();

      const conn = getOrCreateDataConn(hostPeerId, hostName);
      const send = () => conn.send({ type: 'join-room', name: myUsername });
      if (conn.open) send(); else conn.on('open', send);

      setTimeout(() => {
        if (room.active && room.members.length === 1){
          toast('Não foi possível entrar na sala — o anfitrião pode estar offline.', 'error');
          leaveRoom(true);
        }
      }, 8000);
    })
    .catch(() => toast('Não foi possível acessar câmera/microfone.', 'error'));
}

function hostAddMember(peerId, name){
  const already = room.members.some(m => m.id === peerId);
  if (!already && room.members.length >= MAX_ROOM_SIZE){
    const conn = dataConns[peerId];
    if (conn && conn.open) conn.send({ type: 'room-full' });
    return;
  }
  if (!already) room.members.push({ id: peerId, name: name || peerId });
  broadcastRoster();
  renderRoomGrid();
  meshConnectAll();
}

function hostRemoveMember(peerId){
  room.members = room.members.filter(m => m.id !== peerId);
  broadcastRoster();
  closeMediaCallTo(peerId);
  renderRoomGrid();
}

function broadcastRoster(){
  room.members.forEach(m => {
    if (m.id === myPeerId) return;
    const conn = dataConns[m.id];
    if (conn && conn.open) conn.send({ type: 'roster', members: room.members });
  });
}

function applyRoster(members){
  if (!room.active) return;
  room.members = members;
  renderRoomGrid();
  meshConnectAll();
}

function meshConnectAll(){
  room.members.forEach(m => {
    if (m.id === myPeerId || room.mediaCalls[m.id]) return;
    // desempate: só quem tem o id "menor" liga — evita ligação dupla no par
    if (myPeerId < m.id){
      const call = peer.call(m.id, room.localStream, { metadata: { name: myUsername } });
      wireRoomMediaCall(call);
    }
  });
}

function wireRoomMediaCall(call){
  room.mediaCalls[call.peer] = call;
  call.on('stream', remoteStream => {
    room.remoteStreams[call.peer] = remoteStream;
    renderRoomGrid();
  });
  call.on('close', () => { delete room.mediaCalls[call.peer]; delete room.remoteStreams[call.peer]; renderRoomGrid(); });
  call.on('error', () => { delete room.mediaCalls[call.peer]; });
}

function closeMediaCallTo(peerId){
  const c = room.mediaCalls[peerId];
  if (c){ try { c.close(); } catch(e){} delete room.mediaCalls[peerId]; }
  delete room.remoteStreams[peerId];
}

function leaveRoom(silent){
  if (!room.active) return;

  if (room.isHost){
    room.members.forEach(m => { const c = dataConns[m.id]; if (c && c.open) c.send({ type: 'room-closed' }); });
  } else {
    const hostConn = dataConns[room.hostPeerId];
    if (hostConn && hostConn.open) hostConn.send({ type: 'left-room' });
  }

  Object.values(room.mediaCalls).forEach(c => { try { c.close(); } catch(e){} });
  if (room.localStream) room.localStream.getTracks().forEach(t => t.stop());

  room = { active: false, isHost: false, hostPeerId: null, members: [], localStream: null, mediaCalls: {}, remoteStreams: {} };
  closeRoomPanel();
  if (!silent) toast('Você saiu da sala.');
}

function openRoomPanel(){
  el('panel-empty').classList.add('hidden');
  el('panel-chat').classList.add('hidden');
  el('panel-room').classList.remove('hidden');
  el('room-host-name').textContent = room.isHost ? myUsername : friendNameForPeerId(room.hostPeerId) || '—';
  renderRoomGrid();
}

function closeRoomPanel(){
  el('panel-room').classList.add('hidden');
  el('panel-empty').classList.remove('hidden');
  el('room-grid').innerHTML = '';
}

function renderRoomGrid(){
  el('room-member-count').textContent = room.members.length;
  const grid = el('room-grid');
  grid.innerHTML = '';

  room.members.forEach(m => {
    const tile = document.createElement('div');
    tile.className = 'room-tile' + (m.id === myPeerId ? ' is-me' : '');

    const stream = m.id === myPeerId ? room.localStream : room.remoteStreams[m.id];
    if (stream){
      const video = document.createElement('video');
      video.autoplay = true; video.playsInline = true;
      if (m.id === myPeerId) video.muted = true;
      video.srcObject = stream;
      tile.appendChild(video);
    } else {
      const avatar = document.createElement('div');
      avatar.className = 'avatar';
      avatar.textContent = initials(m.name);
      tile.appendChild(avatar);
    }

    const label = document.createElement('div');
    label.className = 'room-tile-label';
    label.textContent = m.id === myPeerId ? (m.name + ' (você)') : m.name;
    tile.appendChild(label);

    grid.appendChild(tile);
  });
}
