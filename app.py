import os
import random
from flask import Flask, render_template, request
from flask_socketio import SocketIO, emit, join_room

app = Flask(__name__)
app.config['SECRET_KEY'] = os.environ.get('SECRET_KEY', 'change-this-in-production')
socketio = SocketIO(app)

# ---------------------------------------------------------------
# rooms structure:
# {
#   'ROOMCODE': {
#     'players': { sid: {name, is_fake_artist, score} },
#     'host': sid,
#     'phase': 'lobby' | 'playing' | 'voting' | 'reveal',
#     'strokes': [ [seg, seg, ...], ... ],   # committed strokes
#     'current_word': str | None,
#     'current_category': str | None,
#     'votes': { voter_sid: suspect_sid },
#   }
# }
# ---------------------------------------------------------------

rooms = {}

PLAYER_COLORS = ['#ff6b6b', '#4ecdc4', '#ffd93d', '#6c5ce7', '#fab1a0', '#55efc4', '#fdcb6e', '#e17055']

WORD_BANK = {
    "Food":     ["Pizza", "Sushi", "Taco", "Croissant", "Ramen"],
    "Animals":  ["Elephant", "Octopus", "Flamingo", "Platypus", "Penguin"],
    "Places":   ["Lighthouse", "Pyramid", "Volcano", "Igloo", "Waterfall"],
    "Objects":  ["Skateboard", "Telescope", "Accordion", "Compass", "Hourglass"],
    "Actions":  ["Swimming", "Juggling", "Skydiving", "Surfing", "Moonwalking"],
}


# ---------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------

def get_player_room(sid):
    """Return the room code this sid belongs to, or None."""
    for room, data in rooms.items():
        if sid in data['players']:
            return room
    return None


def broadcast_player_list(room):
    room_data = rooms[room]
    player_list = [
        {
            "name": info["name"],
            "score": info["score"],
            "color": info.get("color"),
            "sid": sid,
            "is_host": (sid == room_data['host'])
        }
        for sid, info in room_data['players'].items()
    ]
    emit('update_players', {'players': player_list}, room=room)


def next_turn(room):
    room_data = rooms[room]
    order = room_data['turn_order']
    room_data['turn_index'] = (room_data['turn_index'] + 1) % len(order)
    current_sid = order[room_data['turn_index']]
    current_name = room_data['players'][current_sid]['name']
    socketio.emit('turn_changed', {
        'current_sid': current_sid,
        'current_name': current_name
    }, room=room)
    socketio.start_background_task(turn_timeout_watcher, room, room_data['turn_index'])


def turn_timeout_watcher(room, turn_index_snapshot):
    socketio.sleep(20)
    if room not in rooms:
        return
    room_data = rooms[room]
    if room_data.get('phase') != 'playing':
        return
    # only force-advance if nobody ended the turn manually
    if room_data.get('turn_index') == turn_index_snapshot:
        next_turn(room)


# ---------------------------------------------------------------
# HTTP route
# ---------------------------------------------------------------

@app.route('/')
def index():
    return render_template('index.html')


# ---------------------------------------------------------------
# Connection lifecycle
# ---------------------------------------------------------------

@socketio.on('connect')
def handle_connect():
    print(f'Client connected: {request.sid}')


@socketio.on('disconnect')
def handle_disconnect():
    sid = request.sid
    room = get_player_room(sid)
    if room is None:
        return

    room_data = rooms[room]
    players = room_data['players']
    name = players[sid]['name']
    was_fake = players[sid].get('is_fake_artist', False)
    del players[sid]

    emit('chat_message', {
        'sender': 'System',
        'text': f'{name} left the room.'
    }, room=room)

    # pass host if host left
    if room_data.get('host') == sid:
        remaining = list(players.keys())
        if remaining:
            new_host = remaining[0]
            room_data['host'] = new_host
            emit('you_are', {'host': True}, room=new_host)
            emit('chat_message', {
                'sender': 'System',
                'text': f'{players[new_host]["name"]} is now the host.'
            }, room=room)

    # if fake artist left mid-game, end the game
    if was_fake and room_data.get('phase') == 'playing':
        emit('chat_message', {
            'sender': 'System',
            'text': '⚠️ The Fake Artist disconnected — game cancelled. Start a new game.'
        }, room=room)
        room_data['phase'] = 'lobby'
        emit('phase_changed', {'phase': 'lobby'}, room=room)
        for p in players.values():
            p['is_fake_artist'] = False

    # clean up empty rooms
    if not players:
        del rooms[room]
        return

    broadcast_player_list(room)


# ---------------------------------------------------------------
# Room leaving
# ---------------------------------------------------------------

@socketio.on('leave_room')
def handle_leave_room(data):
    sid = request.sid
    room = data.get('room')
    if not room or room not in rooms or sid not in rooms[room]['players']:
        return
    room_data = rooms[room]
    players = room_data['players']
    name = players[sid]['name']
    del players[sid]

    emit('chat_message', {
        'sender': 'System',
        'text': f'{name} left the room.'
    }, room=room)

    if room_data.get('host') == sid:
        remaining = list(players.keys())
        if remaining:
            new_host = remaining[0]
            room_data['host'] = new_host
            emit('you_are', {'host': True}, room=new_host)
            emit('chat_message', {
                'sender': 'System',
                'text': f'{players[new_host]["name"]} is now the host.'
            }, room=room)

    if not players:
        del rooms[room]
        return

    broadcast_player_list(room)


# ---------------------------------------------------------------
# Room joining
# ---------------------------------------------------------------

@socketio.on('join_room')
def handle_join_room(data):
    room = data['room'].strip().upper()
    name = data['name'].strip()
    sid = request.sid

    if not room or not name:
        return

    join_room(room)

    if room not in rooms:
        rooms[room] = {
            'players': {},
            'host': sid,
            'phase': 'lobby',
            'strokes': [],
            'current_word': None,
            'current_category': None,
            'votes': {},
            'turn_order': [],
            'turn_index': 0,
        }

    rooms[room]['players'][sid] = {
        "name": name,
        "is_fake_artist": False,
        "score": 0,
        "color": None
    }

    is_host = (rooms[room]['host'] == sid)
    emit('you_are', {'host': is_host}, room=sid)

    # sync canvas history for late joiners
    emit('redraw', {'strokes': rooms[room]['strokes']}, room=sid)

    emit('chat_message', {
        'sender': 'System',
        'text': f'{name} joined the room!'
    }, room=room)
    emit('phase_changed', {'phase': rooms[room]['phase']}, room=sid)
    broadcast_player_list(room)


# ---------------------------------------------------------------
# Drawing
# ---------------------------------------------------------------

@socketio.on('draw')
def handle_draw(data):
    room = data.get('room')
    if not room or room not in rooms:
        return
    emit('draw', data, room=room, include_self=False)


@socketio.on('commit_stroke')
def handle_commit_stroke(data):
    room = data.get('room')
    if not room or room not in rooms:
        return
    segments = data.get('segments', [])
    if segments:
        rooms[room]['strokes'].append(segments)


@socketio.on('redraw')
def handle_redraw(data):
    room = data.get('room')
    if not room or room not in rooms:
        return
    emit('redraw', {'strokes': rooms[room]['strokes']}, room=room)


@socketio.on('clear')
def handle_clear(data):
    """
    Lobby: wipe everything for everyone.
    Playing: wipe only the current player's in-progress stroke (redraw from history).
    """
    room = data.get('room')
    if not room or room not in rooms:
        return
    phase = rooms[room]['phase']
    if phase == 'lobby':
        rooms[room]['strokes'] = []
        emit('clear_all', {}, room=room)
    elif phase == 'playing':
        # just resend history so everyone redraws without the in-progress stroke
        emit('redraw', {'strokes': rooms[room]['strokes']}, room=room)


# ---------------------------------------------------------------
# Chat
# ---------------------------------------------------------------

@socketio.on('chat_message')
def handle_chat(data):
    sid = request.sid
    room = get_player_room(sid)
    if room is None:
        return
    name = rooms[room]['players'][sid]['name']
    emit('chat_message', {
        'sender': name,
        'text': data['text']
    }, room=room)


# ---------------------------------------------------------------
# Game flow
# ---------------------------------------------------------------

@socketio.on('start_game')
def handle_start_game(data):
    room = data.get('room')
    if not room or room not in rooms:
        return

    room_data = rooms[room]

    # only host can start
    if request.sid != room_data['host']:
        return

    players = room_data['players']
    player_sids = list(players.keys())

    if len(player_sids) < 3:
        emit('chat_message', {
            'sender': 'System',
            'text': '⚠️ Need at least 3 players to start!'
        }, room=request.sid)
        return

    # pick word + fake artist
    category = random.choice(list(WORD_BANK.keys()))
    secret_word = random.choice(WORD_BANK[category])
    fake_artist_sid = random.choice(player_sids)

    # reset state
    room_data['strokes'] = []
    room_data['votes'] = {}
    room_data['current_word'] = secret_word
    room_data['current_category'] = category
    room_data['turn_order'] = player_sids[:]
    room_data['turn_index'] = 0
    room_data['phase'] = 'playing'

    # assign colors
    random.shuffle(PLAYER_COLORS)
    for i, sid in enumerate(player_sids):
        players[sid]['color'] = PLAYER_COLORS[i % len(PLAYER_COLORS)]
        players[sid]['is_fake_artist'] = (sid == fake_artist_sid)

    # wipe canvas for everyone (clear lobby doodles)
    emit('clear_all', {}, room=room)
    emit('phase_changed', {'phase': 'playing'}, room=room)
    broadcast_player_list(room)

    # send private role to each player
    for sid in player_sids:
        is_fake = players[sid]['is_fake_artist']
        emit('your_role', {
            'is_fake_artist': is_fake,
            'category': category,
            'word': None if is_fake else secret_word
        }, room=sid)

    # announce first turn
    first_sid = player_sids[0]
    emit('turn_changed', {
        'current_sid': first_sid,
        'current_name': players[first_sid]['name']
    }, room=room)
    socketio.start_background_task(turn_timeout_watcher, room, 0)

    print(f"[{room}] Game started. Word: '{secret_word}' ({category}). "
          f"Fake: {players[fake_artist_sid]['name']}")


@socketio.on('end_turn')
def handle_end_turn(data):
    room = data.get('room')
    if not room or room not in rooms:
        return
    room_data = rooms[room]
    if room_data['phase'] != 'playing':
        return

    order = room_data['turn_order']
    current_sid = order[room_data['turn_index']]

    # only the current player can end their turn
    if request.sid != current_sid:
        return

    next_turn(room)


@socketio.on('request_voting')
def handle_request_voting(data):
    room = data.get('room')
    if not room or room not in rooms:
        return
    room_data = rooms[room]

    # only host can trigger voting
    if request.sid != room_data['host']:
        return

    room_data['phase'] = 'voting'
    room_data['votes'] = {}

    player_list = [
        {'sid': sid, 'name': info['name']}
        for sid, info in room_data['players'].items()
    ]
    emit('phase_changed', {'phase': 'voting'}, room=room)
    emit('start_voting', {'players': player_list}, room=room)


@socketio.on('cast_vote')
def handle_cast_vote(data):
    room = data.get('room')
    if not room or room not in rooms:
        return
    room_data = rooms[room]
    if room_data['phase'] != 'voting':
        return

    room_data['votes'][request.sid] = data['suspect_sid']

    # reveal once everyone has voted
    if len(room_data['votes']) >= len(room_data['players']):
        reveal_results(room)


def reveal_results(room):
    room_data = rooms[room]
    players = room_data['players']

    fake_sid = next(
        (sid for sid, p in players.items() if p.get('is_fake_artist')),
        None
    )
    if fake_sid is None:
        return

    votes = room_data['votes']
    vote_counts = {}
    for suspect in votes.values():
        vote_counts[suspect] = vote_counts.get(suspect, 0) + 1

    most_voted_sid = max(vote_counts, key=vote_counts.get) if vote_counts else None
    caught = (most_voted_sid == fake_sid)

    room_data['phase'] = 'reveal'
    emit('phase_changed', {'phase': 'reveal'}, room=room)
    emit('reveal_results', {
        'caught': caught,
        'fake_artist_name': players[fake_sid]['name'],
        'word': room_data['current_word'],
        'category': room_data['current_category'],
    }, room=room)


@socketio.on('back_to_lobby')
def handle_back_to_lobby(data):
    room = data.get('room')
    if not room or room not in rooms:
        return
    if request.sid != rooms[room]['host']:
        return

    room_data = rooms[room]
    room_data['phase'] = 'lobby'
    room_data['strokes'] = []
    room_data['votes'] = {}
    room_data['current_word'] = None
    room_data['current_category'] = None
    for p in room_data['players'].values():
        p['is_fake_artist'] = False

    emit('clear_all', {}, room=room)
    emit('phase_changed', {'phase': 'lobby'}, room=room)


if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5000))
    socketio.run(app, host='0.0.0.0', port=port, debug=False)