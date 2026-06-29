const canvas = document.getElementById('drawingCanvas');
const ctx = canvas.getContext('2d');

let currentColor = '#2b3340';
let currentWidth = 4;
ctx.strokeStyle = currentColor;
ctx.lineWidth = currentWidth;
ctx.lineCap = 'round';
ctx.lineJoin = 'round';

// ---- Global State ----

let myName = '';
let myRoom = '';
let isHost = false;
let isMyTurn = false;
let phase = 'lobby';
let currentTurnSid = null;
let currentTurnName = null;
let playerSidMap = {};
let currentStroke = [];

// ---- Canvas Helpers ----

function getCanvasPos(e) {
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    return {
        x: (e.clientX - rect.left) * scaleX,
        y: (e.clientY - rect.top) * scaleY
    };
}

function drawLine(x1, y1, x2, y2, color, width) {
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
    ctx.restore();
}

function clearCanvas() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
}

// ---- Socket ----

const socket = io();

socket.on('connect', () => {
    document.getElementById('connectionDot').classList.add('connected');
});

socket.on('disconnect', () => {
    document.getElementById('connectionDot').classList.remove('connected');
});

// ---- Drawing: Local + Network ----

let isDrawing = false;
let hasDrawnThisTurn = false;
let lastX = 0;
let lastY = 0;

canvas.addEventListener('mousedown', (e) => {
    if (phase !== 'playing' || !isMyTurn || hasDrawnThisTurn) return;
    isDrawing = true;
    const pos = getCanvasPos(e);
    lastX = pos.x;
    lastY = pos.y;
    currentStroke = [{ x: pos.x, y: pos.y, color: currentColor, width: currentWidth }];
});

canvas.addEventListener('mouseup', () => {
    if (isDrawing && isMyTurn && phase === 'playing' && currentStroke.length > 1) {
        socket.emit('commit_stroke', { room: myRoom, segments: currentStroke });
        socket.emit('end_turn', { room: myRoom });
        isMyTurn = false;
    }
    isDrawing = false;
});

canvas.addEventListener('mousemove', (e) => {
    if (!isDrawing) return;
    hasDrawnThisTurn = true;
    const pos = getCanvasPos(e);

    currentStroke.push({ x: pos.x, y: pos.y, color: currentColor, width: currentWidth });

    drawLine(lastX, lastY, pos.x, pos.y, currentColor, currentWidth);

    socket.emit('draw', {
        x1: lastX,
        y1: lastY,
        x2: pos.x,
        y2: pos.y,
        color: currentColor,
        width: currentWidth,
        room: myRoom
    });

    lastX = pos.x;
    lastY = pos.y;
});

window.addEventListener('mouseup', () => {
    if (isDrawing && isMyTurn && phase === 'playing' && currentStroke.length > 1) {
        socket.emit('commit_stroke', { room: myRoom, segments: currentStroke });
        socket.emit('end_turn', { room: myRoom });
        isMyTurn = false;
    }
    isDrawing = false;
    currentStroke = [];
});

canvas.addEventListener('mouseleave', () => {
    isDrawing = false;
});

document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
        isDrawing = false;
    }
});

window.addEventListener('blur', () => {
    isDrawing = false;
});

// Receive remote draw events
socket.on('draw', data => {
    drawLine(data.x1, data.y1, data.x2, data.y2, data.color, data.width);
});

// ---- Redraw / Clear ----

socket.on('clear_all', () => {
    clearCanvas();
});

socket.on('redraw', (data) => {
    clearCanvas();
    (data.strokes || []).forEach(stroke => {
        stroke.forEach((seg, i) => {
            if (i === 0) return;
            const prev = stroke[i - 1];
            drawLine(prev.x, prev.y, seg.x, seg.y, seg.color, seg.width);
        });
    });
});



// ---- Size Slider ----

const sizeSlider = document.getElementById('sizeSlider');
const sizeValue = document.getElementById('sizeValue');

sizeSlider.addEventListener('input', () => {
    currentWidth = Number(sizeSlider.value);
    sizeValue.textContent = currentWidth;
});

// ---- Chat ----

const chatForm = document.getElementById('chatForm');
const chatInput = document.getElementById('chatInput');
const chatLog = document.getElementById('chatLog');

chatForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = chatInput.value.trim();
    if (!text) return;
    socket.emit('chat_message', { text });
    chatInput.value = '';
});

socket.on('chat_message', (data) => {
    const div = document.createElement('div');
    if (data.sender === 'System') {
        div.className = 'chat-message system';
        div.textContent = data.text;
    } else {
        div.className = 'chat-message';
        div.innerHTML = `<span class="sender">${data.sender}:</span>${data.text}`;
    }
    chatLog.appendChild(div);
    chatLog.scrollTop = chatLog.scrollHeight;
});

// ---- Return to Home (leave room) ----

function returnToHome() {
    socket.emit('leave_room', { room: myRoom });
    document.getElementById('gameContainer').style.display = 'none';
    document.getElementById('lobbyOverlay').style.display = 'flex';
    document.getElementById('votingOverlay').style.display = 'none';
    document.getElementById('revealOverlay').style.display = 'none';
    clearCanvas();
    myRoom = '';
    myName = '';
    isHost = false;
    isMyTurn = false;
    phase = 'lobby';
    currentTurnSid = null;
    currentTurnName = null;
    currentStroke = [];
    hasDrawnThisTurn = false;
    clearInterval(timerInterval);
    document.getElementById('roleBanner').className = 'role-banner';
    document.getElementById('roleBanner').style.display = 'none';
}

// ---- Leave Room Button ----

document.getElementById('leaveLobbyBtn').addEventListener('click', () => {
    returnToHome();
});

// ---- Lobby Join ----

document.getElementById('joinBtn').addEventListener('click', () => {
    const name = document.getElementById('nameInput').value.trim();
    const room = document.getElementById('roomInput').value.trim().toUpperCase();
    if (!name || !room) { alert('Enter both a name and room code!'); return; }

    myName = name;
    myRoom = room;

    socket.emit('join_room', { name, room });

    document.getElementById('lobbyOverlay').style.display = 'none';
    document.getElementById('gameContainer').style.display = 'grid';
    document.getElementById('leaveLobbyBtn').style.display = 'block';
});

// ---- Player List ----

const avatarEmojis = ['🎨','🦊','🐸','🐙','🦄','🐧','🦁','🐝'];
const avatarColors = ['#ff6b6b','#4ecdc4','#ffd93d','#6c5ce7','#fab1a0','#55efc4'];

function renderPlayers(playerList) {
    const panel = document.getElementById('playersPanel');
    panel.innerHTML = '';
    playerSidMap = {};
    playerList.forEach((p, i) => {
        const card = document.createElement('div');
        card.className = 'player-card';
        const color = p.color || avatarColors[i % avatarColors.length];
        card.style.borderLeftColor = color;
        if (p.name && currentTurnName && p.name === currentTurnName) {
            card.classList.add('active-turn');
        }
        card.innerHTML = `
        <div class="avatar" style="background:${color}">
            ${avatarEmojis[i % avatarEmojis.length]}
        </div>
        <div class="player-info">
            <span class="player-name">${p.name}</span>
            <span class="player-score">${p.score} pts</span>
            ${p.is_host ? '<span class="player-host-badge">Host</span>' : ''}
        </div>`;
        panel.appendChild(card);
        playerSidMap[p.name] = card;
    });
}

socket.on('update_players', (data) => {
    renderPlayers(data.players);
    const me = data.players.find(p => p.sid === socket.id);
    if (me && me.color) {
        currentColor = me.color;
        ctx.strokeStyle = currentColor;
    }
});

// ---- Host Status ----

socket.on('you_are', (data) => {
    isHost = data.host;
    document.getElementById('startGameBtn').style.display = isHost ? 'block' : 'none';
    document.getElementById('endRoundBtn').style.display = 'none';
});

// ---- Phase Changes ----

socket.on('phase_changed', (data) => {
    phase = data.phase;
    const endRoundBtn = document.getElementById('endRoundBtn');
    const startGameBtn = document.getElementById('startGameBtn');
    const turnStatus = document.getElementById('turnStatus');

    clearInterval(timerInterval);

    switch (phase) {
        case 'lobby':
            isMyTurn = false;
            hasDrawnThisTurn = false;
            currentTurnSid = null;
            startGameBtn.style.display = isHost ? 'block' : 'none';
            endRoundBtn.style.display = 'none';
            document.getElementById('roleBanner').className = 'role-banner';
            document.getElementById('roleBanner').style.display = 'none';
            turnStatus.textContent = 'Waiting for game to start...';
            document.getElementById('votingOverlay').style.display = 'none';
            document.getElementById('revealOverlay').style.display = 'none';
            clearCanvas();
            break;
        case 'playing':
            endRoundBtn.style.display = isHost ? 'block' : 'none';
            startGameBtn.style.display = 'none';
            document.getElementById('votingOverlay').style.display = 'none';
            break;
        case 'voting':
            isMyTurn = false;
            turnStatus.textContent = '🗳️ Voting in progress...';
            break;
        case 'reveal':
            isMyTurn = false;
            turnStatus.textContent = 'Round over!';
            break;
    }
});

// ---- Start Game ----

document.getElementById('startGameBtn').addEventListener('click', () => {
    socket.emit('start_game', { room: myRoom });
});

// ---- Role Banner ----

socket.on('your_role', (data) => {
    const banner = document.getElementById('roleBanner');
    banner.style.display = 'block';
    if (data.is_fake_artist) {
        banner.textContent = `🤫 Fake Artist! Category: ${data.category} — fake it!`;
        banner.className = 'role-banner fake-artist';
    } else {
        banner.textContent = `Category: ${data.category} · Word: ${data.word}`;
        banner.className = 'role-banner real-artist';
    }
});

// ---- Turn Management ----

function highlightPlayerCard(name) {
    document.querySelectorAll('.player-card').forEach(c => c.classList.remove('active-turn'));
    const card = playerSidMap[name];
    if (card) card.classList.add('active-turn');
}

socket.on('turn_changed', (data) => {
    isMyTurn = (data.current_sid === socket.id);
    hasDrawnThisTurn = false;
    currentTurnSid = data.current_sid;
    currentTurnName = data.current_name;

    const status = document.getElementById('turnStatus');
    if (isMyTurn) {
        status.textContent = "🖊️ Your turn — draw one stroke!";
    } else {
        status.textContent = `Waiting for ${data.current_name} to draw...`;
    }

    highlightPlayerCard(data.current_name);
    startTimerBar(20);
});

// ---- Timer Bar ----

let timerInterval = null;

function startTimerBar(seconds) {
    clearInterval(timerInterval);
    const startTime = Date.now();
    const fill = document.getElementById('timerFill');
    fill.style.width = '100%';
    fill.classList.remove('urgent');

    timerInterval = setInterval(() => {
        const elapsed = (Date.now() - startTime) / 1000;
        const remaining = Math.max(0, seconds - elapsed);
        const pct = (remaining / seconds) * 100;
        fill.style.width = pct + '%';
        if (remaining <= 3) fill.classList.add('urgent');
        if (remaining <= 0) clearInterval(timerInterval);
    }, 100);
}

// ---- End Round & Vote ----

document.getElementById('endRoundBtn').addEventListener('click', () => {
    socket.emit('request_voting', { room: myRoom });
});

// ---- Voting ----

socket.on('start_voting', (data) => {
    const overlay = document.getElementById('votingOverlay');
    const optionsDiv = document.getElementById('voteOptions');
    const waitingMsg = document.getElementById('voteWaiting');
    optionsDiv.innerHTML = '';
    waitingMsg.textContent = 'Waiting for others to vote...';

    data.players.forEach(p => {
        if (p.sid === socket.id) return;
        const btn = document.createElement('button');
        btn.className = 'vote-option-btn';
        btn.textContent = p.name;
        btn.dataset.sid = p.sid;
        btn.addEventListener('click', () => {
            if (btn.disabled) return;
            document.querySelectorAll('.vote-option-btn').forEach(b => {
                b.disabled = true;
                if (b !== btn) b.style.opacity = '0.4';
            });
            btn.classList.add('selected');
            btn.style.opacity = '1';
            waitingMsg.textContent = 'Vote cast! Waiting for others...';
            socket.emit('cast_vote', { room: myRoom, suspect_sid: p.sid });
        });
        optionsDiv.appendChild(btn);
    });

    if (data.players.length <= 1) {
        optionsDiv.innerHTML = '<p style="color:#a8b3c4;">Not enough players to vote.</p>';
        waitingMsg.textContent = '';
    }

    overlay.style.display = 'flex';
});

// ---- Reveal ----

socket.on('reveal_results', (data) => {
    document.getElementById('votingOverlay').style.display = 'none';
    document.getElementById('revealOutcome').textContent =
        data.caught ? '🎉 The Fake Artist was caught!' : '😈 The Fake Artist got away!';
    document.getElementById('revealDetails').innerHTML =
        `<strong>${data.fake_artist_name}</strong> was the Fake Artist.<br>The word was <strong>"${data.word}"</strong> (${data.category}).`;
    document.getElementById('revealOverlay').style.display = 'flex';
});

// ---- Play Again ----

document.getElementById('playAgainBtn').addEventListener('click', () => {
    document.getElementById('revealOverlay').style.display = 'none';
    clearCanvas();
    socket.emit('start_game', { room: myRoom });
});

// ---- Back to Lobby ----

document.getElementById('backToLobbyBtn').addEventListener('click', () => {
    document.getElementById('revealOverlay').style.display = 'none';
    returnToHome();
});
