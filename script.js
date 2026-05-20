/* --- JS START --- */

// --- AUDIO ENGINE ---
const AudioEngine = {
    ctx: null,
    init() {
        if (!this.ctx) {
            this.ctx = new (window.AudioContext || window.webkitAudioContext)();
        }
        if (this.ctx.state === 'suspended') this.ctx.resume();
    },
    playTone(freq, type, duration, vol = 0.1) {
        if (!this.ctx) return;
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();
        osc.type = type;
        osc.frequency.setValueAtTime(freq, this.ctx.currentTime);
        gain.gain.setValueAtTime(vol, this.ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, this.ctx.currentTime + duration);
        osc.connect(gain);
        gain.connect(this.ctx.destination);
        osc.start();
        osc.stop(this.ctx.currentTime + duration);
    },
    playNoise(duration) {
        if (!this.ctx) return;
        const bufferSize = this.ctx.sampleRate * duration;
        const buffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
        const data = buffer.getChannelData(0);
        for (let i = 0; i < bufferSize; i++) data[i] = Math.random() * 2 - 1;
        const noise = this.ctx.createBufferSource();
        noise.buffer = buffer;
        const gain = this.ctx.createGain();
        gain.gain.setValueAtTime(0.2, this.ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, this.ctx.currentTime + duration);
        const filter = this.ctx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.value = 800;
        noise.connect(filter);
        filter.connect(gain);
        gain.connect(this.ctx.destination);
        noise.start();
    },
    sfxHit() { this.playTone(600, 'square', 0.1, 0.1); this.playTone(800, 'sine', 0.1, 0.1); },
    sfxSwing() { this.playTone(200, 'triangle', 0.15, 0.05); },
    sfxDie() { this.playNoise(0.4); this.playTone(100, 'sawtooth', 0.4, 0.2); },
    sfxWin() { [440, 554, 659, 880].forEach((f, i) => setTimeout(() => this.playTone(f, 'square', 0.3, 0.1), i * 100)); },
    sfxBlip() { this.playTone(800, 'sine', 0.05, 0.1); },
    sfxGo() { this.playTone(1200, 'square', 0.4, 0.1); }
};

// --- CONFIGURATION ---
const CANVAS_SIZE = 700;
const BASE_RADIUS = 250;
const START_SPEED = 0.015;
// Increased max speed so late-game becomes much faster if hits chain
// Raised further per user request
const MAX_SPEED = 0.11;
// Reduce speed increment per hit so games last longer; adjust to taste (1.0 = no change)
const SPEED_INC = 1.015;
// Periodic speed boost: every SPEED_BOOST_INTERVAL_MS multiply ball speed by SPEED_BOOST_MULT
const SPEED_BOOST_INTERVAL_MS = 20000; // 20 seconds
const SPEED_BOOST_MULT = 1.1; // small incremental boost
// Game end rules
const MAX_GAME_DURATION_MS = 10 * 60 * 1000; // 10 minutes
const DUCK_LIMIT = 50; // ducks needed to eliminate a player
const SWING_DURATION = 15;
const COOLDOWN = 30;
// How long a bot will stay ducked (in frames) after choosing to duck
const DUCK_HOLD = 30;

// CUSTOM NAMES
const HUMAN_NAMES = ["Player 1", "Player 2", "Player 3", "Player 4", "Player 5", "Player 6", "Player 7", "Player 8"];
const BOT_NAMES = ["Jack", "Charlie", "David", "Sarah", "Emily", "Sophia", "Thomas", "Olivia"];

// Bot Profiles
const BOT_PROFILES = {
    // errorRange: Random timing offset (frames). Larger = more misses.
    // duckChance: Probability to Panic Duck if on cooldown.
    // hitChance: Base probability (0-1) to attempt a successful hit when timing lines up.
    easy: { errorRange: 8.0, duckChance: 0.2, hitChance: 0.15 },
    // Lowered medium/hard base hitChance so they don't become near-perfect over time
    medium: { errorRange: 4.0, duckChance: 0.45, hitChance: 0.5 },
    hard: { errorRange: 1.5, duckChance: 0.75, hitChance: 0.75 },
    // Impossible remains near-certain
    impossible: { errorRange: 0.0, duckChance: 0.99, hitChance: 0.99 }
};

// Controls: [Hit Key, Duck Key, Display Hit, Display Duck]
const KEY_CONFIG = [
    ['a', 's', 'A', 'S'],
    ['ArrowUp', 'ArrowDown', '↑', '↓'],
    ['g', 'h', 'G', 'H'],
    ['k', 'l', 'K', 'L'],
    ['c', 'v', 'C', 'V'],
    ['n', 'm', 'N', 'M'],
    ['q', 'w', 'Q', 'W'],
    ['o', 'p', 'O', 'P']
];

const COLORS = [
    '#ef4444', '#3b82f6', '#22c55e', '#eab308',
    '#a855f7', '#ec4899', '#f97316', '#14b8a6'
];

// --- GAME STATE ---
const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');
const uiMenu = document.getElementById('menu-screen');
const uiGameOver = document.getElementById('game-over-screen');

const STATE = {
    MENU: 0,
    LOBBY: 1,
    COUNTDOWN: 2,
    PLAYING: 3,
    GAMEOVER: 4,
    PAUSED: 5
};

let game = {
    phase: STATE.MENU,
    totalPlayers: 4,
    humanCount: 1,
    difficulty: 'easy',
    mode: 'standard',
    zones: [], // For game modes that use zones (e.g., Flip Zone)
    players: [],
    deadPlayers: [],
    ball: {},
    particles: [],
    stars: [],
    killfeed: [],
    shake: 0,
    flash: 0,
    countdown: 3,
    countdownTimer: 0,
    tick: 0
};

let keys = {};
let animationId = null;

// --- SETUP ---
canvas.width = CANVAS_SIZE;
canvas.height = CANVAS_SIZE;

// Background Stars
for (let i = 0; i < 100; i++) {
    game.stars.push({
        x: Math.random() * CANVAS_SIZE,
        y: Math.random() * CANVAS_SIZE,
        size: Math.random() * 2,
        alpha: Math.random()
    });
}

// Input
window.addEventListener('keydown', e => {
    keys[e.key.toLowerCase()] = true;
    keys[e.code] = true;
    if (e.key === "ArrowUp") keys["ArrowUp"] = true;
    if (e.key === "ArrowDown") keys["ArrowDown"] = true;
});
window.addEventListener('keyup', e => {
    keys[e.key.toLowerCase()] = false;
    keys[e.code] = false;
    if (e.key === "ArrowUp") keys["ArrowUp"] = false;
    if (e.key === "ArrowDown") keys["ArrowDown"] = false;
});

// --- CLASSES ---

class Player {
    constructor(id, angle, isBot) {
        this.id = id;
        this.angle = angle;
        this.isBot = isBot;
        this.color = COLORS[id];
        this.alive = true;
        this.swingTimer = 0;
        this.cooldown = 0;
        this.isDucking = false;
        this.name = "";

        // Lobby Status
        this.ready = isBot;
        this.prevHitState = false;

        // Visual State (For Debugging Bots)
        this.actionColor = null;
        this.actionTimer = 0;

        // Input Config
        const conf = KEY_CONFIG[id];
        this.keyHit = conf[0].toLowerCase();
        this.keyDuck = conf[1].toLowerCase();
        this.labelHit = conf[2];
        this.labelDuck = conf[3];

        // Bot Brain
        this.profile = BOT_PROFILES[game.difficulty];
        this.botState = {
            active: false,
            errorOffset: 0,
            ducking: false
        };
        // Stats
        this.stats = { hits: 0, ducks: 0, kills: 0, perfects: 0 };
        this.points = 100; // Everyone starts with 100 points
        // last-counted tick to avoid double-counting within overlapping frames
        this.lastHitTick = -1;
        this.lastDuckTick = -1;
        // Duck timer for bots and approach-based counting guards
        this.duckTimer = 0;
        this.duckedThisApproach = false;
        this.hitThisApproach = false;
    }

    updateLobby() {
        if (this.isBot) return;
        const hitPressed = keys[this.keyHit] || (this.keyHit === 'arrowup' && keys['ArrowUp']);
        if (hitPressed && !this.prevHitState) {
            this.ready = !this.ready;
            AudioEngine.sfxBlip();
        }
        this.prevHitState = hitPressed;
    }

    updateGame() {
        if (!this.alive) return;

        // VISUAL FLASH TIMER
        if (this.actionTimer > 0) this.actionTimer--;
        if (this.actionTimer === 0) this.actionColor = null;

        let wantHit = false;
        let wantDuck = false;

        if (this.isBot) {
            const actions = this.computeBotMove();
            wantHit = actions.hit;
            wantDuck = actions.duck;
        } else {
            wantHit = keys[this.keyHit] || (this.keyHit === 'arrowup' && keys['ArrowUp']);
            wantDuck = keys[this.keyDuck] || (this.keyDuck === 'arrowdown' && keys['ArrowDown']);
        }

        // Ensure bots/humans do not both attempt to hit and duck simultaneously.
        if (wantHit && wantDuck) {
            if (this.isBot) {
                // tie-break randomly for bots to preserve asymmetry
                if (Math.random() < 0.5) {
                    wantDuck = false;
                } else {
                    wantHit = false;
                }
            } else {
                // for humans prefer hit if both keys pressed
                wantDuck = false;
            }
        }

        if (this.cooldown > 0) this.cooldown--;
        if (this.swingTimer > 0) this.swingTimer--;
        if (this.duckTimer > 0) this.duckTimer--;

        // Execute Actions
        if (this.isBot) {
            // Bots: give them a short hold period so they don't unduck immediately.
            // MUST not be on cooldown to dodge (vulnerability window).
            if (wantDuck && this.cooldown === 0) {
                this.duckTimer = Math.max(this.duckTimer, DUCK_HOLD);
            }
            this.isDucking = (this.duckTimer > 0);
        } else {
            // Humans: duck while the key is held and cooldown is not active
            if (wantDuck && this.cooldown === 0) this.isDucking = true; else this.isDucking = false;
        }

        if (wantHit && this.cooldown === 0 && !this.isDucking) {
            this.swingTimer = SWING_DURATION;
            this.cooldown = COOLDOWN;
            AudioEngine.sfxSwing();
        }
    }

    computeBotMove() {
        // Default No Action
        let result = { hit: false, duck: false };

        const ball = game.ball;
        if (!ball || typeof ball.speed === 'undefined' || ball.speed === 0) return result;

        // Signed angular difference in range [-PI, PI]
        const diff = (ball.angle - this.angle + Math.PI * 3) % (Math.PI * 2) - Math.PI;

        // Compute signed frames to impact: solve for n where ball.angle + n*ball.speed == this.angle
        // Therefore n = (-diff) / ball.speed. Positive n means the ball will reach the player in n frames.
        const framesToImpact = (-diff) / ball.speed;

        // If the ball is moving away or impact is too far in future, reset and bail
        if (framesToImpact <= 0 || framesToImpact > 300) {
            this.botState.active = false;
            this.botState.ducking = false;
            return result;
        }

        // Initialize unique perception error for this specific approach
        if (!this.botState.active) {
            this.botState.active = true;
            this.botState.errorOffset = (Math.random() - 0.5) * this.profile.errorRange;
        }

        // Add per-approach perception + small runtime jitter so bots don't lock into a
        // perfectly tuned offset for every approach. This prevents long-term perfect play
        // on medium/hard where one lucky offset would repeat.
        let perceivedFrames = framesToImpact + this.botState.errorOffset;
        // small random jitter (±1 frame) to keep timing varied
        perceivedFrames += (Math.random() - 0.5) * 2;

        // --- DUCK LOGIC ---
        // If the bot is on cooldown from a swing, it is completely vulnerable.
        // It cannot hit or dodge. Return immediately.
        if (this.cooldown > 0) {
            return result;
        }

        // Strategic duck for very fast balls (except impossible difficulty)
        if (!this.botState.ducking && game.difficulty !== 'impossible' && Math.abs(ball.speed) > 0.14 && framesToImpact < 20) {
            if (Math.random() < 0.02) {
                this.botState.ducking = true;
                this.actionColor = '#facc15';
                this.actionTimer = 5;
                spawnParticles(this.angle, null, 0, false, "💦");
            }
        }

        if (this.botState.ducking) {
            result.duck = true;
            return result;
        }

        // --- HIT LOGIC ---
        // The game registers a hit when the ball is 0.15 radians away (the edge of the player).
        // We calculate exactly how many frames until the ball touches that outer edge.
        const framesToHitbox = perceivedFrames - (0.15 / Math.abs(ball.speed));

        // --- GOD MODE: IMPOSSIBLE BOTS ---
        if (this.profile.hitChance >= 0.95) {
            // To hit a Perfect Smash, they must swing EXACTLY 7.5 frames before the ball touches the hitbox
            const perfectSwingLead = SWING_DURATION / 2;

            if (framesToHitbox <= perfectSwingLead + 0.5) {
                // 10% chance to fake you out with a duck, 90% chance to blast a Perfect hit
                if (Math.random() < 0.10) {
                    result.duck = true; this.actionColor = '#facc15';
                } else {
                    result.hit = true; this.actionColor = '#ffffff';
                }
                this.actionTimer = 5;
                return result;
            }
            return result; // Hold the pose... wait for the perfect pixel...
        }

        // --- NORMAL BOTS (Easy, Medium, Hard) ---

        if (this.cooldown === 0 && this.swingTimer === 0 && !this.isDucking) {

            // 1. Pre-calculate their swing timing for this specific incoming ball.
            // We only calculate this once per approach so they commit to a decision.
            if (!this.targetFrame || framesToHitbox > SWING_DURATION + 10) {
                // The perfect swing is exactly 7.5 frames before impact.
                // We apply their errorRange to make them swing too early or too late!
                let error = Math.random() * (this.profile.errorRange || 2.0);
                let direction = Math.random() > 0.5 ? 1 : -1;
                this.targetFrame = 7.5 + (error * direction);

                // Calculate if they will panic duck based on the ball's speed
                this.currentDuckProb = this.profile.duckChance || 0.2;
                if (Math.abs(ball.speed) > 0.15) {
                    this.currentDuckProb = Math.min(0.9, this.currentDuckProb + 0.3);
                }
            }

            // 2. Wait for the ball to cross their calculated target frame!
            if (framesToHitbox <= this.targetFrame) {
                // They pull the trigger! Will they hit or duck?
                if (Math.random() < this.currentDuckProb) {
                    result.duck = true;
                    this.actionColor = '#facc15';
                } else {
                    result.hit = true;
                    this.actionColor = '#ffffff';
                }

                // Clear the target frame for the next time the ball comes around
                this.targetFrame = null;
                return result;
            }
        }

        // Safety override
        if (result.hit && result.duck) {
            if (Math.random() < 0.5) result.duck = false; else result.hit = false;
        }

        return result;
    }

    draw(ctx, inLobby = false) {
        const x = CANVAS_SIZE / 2 + Math.cos(this.angle) * BASE_RADIUS;
        const y = CANVAS_SIZE / 2 + Math.sin(this.angle) * BASE_RADIUS;

        // DEAD VISUAL
        if (!this.alive && !inLobby) {
            ctx.fillStyle = '#334155';
            ctx.beginPath();
            ctx.arc(x, y, 5, 0, Math.PI * 2);
            ctx.fill();
            return;
        }

        ctx.save();
        ctx.translate(x, y);

        // LOBBY UI
        if (inLobby) {
            const textRadius = 45;
            const tx = Math.cos(this.angle) * textRadius;
            const ty = Math.sin(this.angle) * textRadius;

            ctx.textAlign = "center";
            ctx.textBaseline = "middle";

            if (this.isBot) {
                ctx.font = "bold 12px monospace";
                ctx.fillStyle = "#64748b";
                ctx.fillText(this.name.toUpperCase(), tx, ty); // Uses custom bot name
            } else {
                ctx.font = "bold 14px monospace";
                ctx.fillStyle = "#fff";
                ctx.fillText(`${this.labelHit} / ${this.labelDuck}`, tx, ty);
                ctx.font = "10px sans-serif";
                ctx.fillStyle = "#94a3b8";
                ctx.fillText("HIT  DUCK", tx, ty + 12);
            }

            // Stats: hits and ducks (shown in lobby)
            ctx.font = "10px monospace";
            ctx.fillStyle = "#cbd5e1";
            const hits = this.stats ? this.stats.hits : 0;
            const ducks = this.stats ? this.stats.ducks : 0;
            ctx.fillText(`H:${hits} D:${ducks}`, tx, ty + 28);
            if (this.ready) {
                ctx.beginPath(); ctx.arc(0, 0, 20, 0, Math.PI * 2);
                ctx.strokeStyle = "#22c55e"; ctx.lineWidth = 3; ctx.stroke();
            } else {
                ctx.beginPath(); ctx.arc(0, 0, 20, 0, Math.PI * 2);
                ctx.strokeStyle = "#ef4444"; ctx.lineWidth = 1;
                ctx.setLineDash([4, 4]); ctx.stroke(); ctx.setLineDash([]);
            }
        }

        ctx.rotate(this.angle + Math.PI / 2);

        // Stats during gameplay: display hits/ducks above the player
        if (!inLobby) {
            ctx.save();
            ctx.font = "10px monospace";
            ctx.textAlign = "center";
            ctx.textBaseline = "bottom";
            const hitsG = this.stats ? this.stats.hits : 0;
            const ducksG = this.stats ? this.stats.ducks : 0;
            // draw slightly above the player (before rotating the player body)
            // Draw points above the hits/ducks
            ctx.fillStyle = "#facc15"; // Gold color for points
            ctx.fillText(`PTS: ${this.points}`, 0, -40);
            // Existing hits/ducks line
            ctx.fillStyle = "#cbd5e1";
            ctx.fillText(`H:${hitsG} D:${ducksG}`, 0, -28);
            ctx.restore();
        }

        // PLAYER BODY
        if (this.isBot) {
            ctx.fillStyle = '#fff';
            ctx.fillRect(-2, -18, 4, 4);
        }

        if (this.isDucking) {
            ctx.fillStyle = this.color;
            ctx.globalAlpha = 0.4;
            ctx.fillRect(-12, -6, 24, 12);
        } else {
            // Flash color if taking action (debug help)
            ctx.fillStyle = this.actionColor ? this.actionColor : (this.ready || !inLobby ? this.color : '#475569');

            ctx.shadowColor = this.color;
            ctx.shadowBlur = 15;
            ctx.beginPath();
            ctx.arc(0, 0, 14, 0, Math.PI * 2);
            ctx.fill();
            ctx.strokeStyle = '#fff';
            ctx.lineWidth = 2;
            ctx.stroke();
        }

        // SWING ANIMATION
        if (this.swingTimer > 0) {
            const progress = 1 - (this.swingTimer / SWING_DURATION);
            ctx.strokeStyle = '#fff';
            ctx.shadowBlur = 20;
            ctx.shadowColor = '#fff';
            ctx.lineWidth = 4;
            ctx.beginPath();
            ctx.arc(0, 0, 22, Math.PI - (progress * Math.PI), 2 * Math.PI - (progress * Math.PI)); // Swing arc from 180° to 360° and offset
            ctx.stroke();
        }

        ctx.restore();
    }
}

// --- CORE FUNCTIONS ---

function spawnParticles(angle, color, count, explosive = false, emoteText = null) {
    const cx = CANVAS_SIZE / 2 + Math.cos(angle) * BASE_RADIUS;
    const cy = CANVAS_SIZE / 2 + Math.sin(angle) * BASE_RADIUS;

    // If an emote is passed, just spawn one text particle floating upwards
    if (emoteText) {
        game.particles.push({
            x: cx, y: cy,
            vx: 0,
            vy: -0.8, // Float straight up
            life: 1.5, // Lives a bit longer
            color: '#fff',
            text: emoteText
        });
        return;
    }

    // Standard colored circle particles
    for (let i = 0; i < count; i++) {
        game.particles.push({
            x: cx, y: cy,
            vx: (Math.random() - 0.5) * (explosive ? 15 : 5),
            vy: (Math.random() - 0.5) * (explosive ? 15 : 5),
            life: 1.0,
            color: color,
            text: null
        });
    }
}

function update() {
    // advance global tick (used to prevent double-counting stats during overlapping frames)
    game.tick = (game.tick || 0) + 1;
    // Effects Decay
    if (game.shake > 0) game.shake *= 0.9;
    if (game.shake < 0.5) game.shake = 0;
    if (game.flash > 0) game.flash *= 0.85;

    // --- DYNAMIC ZONE SHIFTING ---
    if (game.phase === STATE.PLAYING && game.mode !== 'standard') {
        game.zoneTimer++;
        // 60 frames * 8 seconds = 480 ticks
        if (game.zoneTimer > 480) {
            game.zoneTimer = 0;
            reshuffleZones(); // Delete old zones and spawn new ones safely!
        }
    }

    // LOBBY LOGIC
    if (game.phase === STATE.LOBBY) {
        let allReady = true;
        game.players.forEach(p => {
            p.updateLobby();
            if (!p.ready) allReady = false;
        });
        if (allReady) {
            game.phase = STATE.COUNTDOWN;
            game.countdown = 3;
            game.countdownTimer = 60;
            AudioEngine.sfxBlip();
        }
        return;
    }

    // COUNTDOWN LOGIC
    if (game.phase === STATE.COUNTDOWN) {
        game.countdownTimer--;
        if (game.countdownTimer <= 0) {
            game.countdown--;
            if (game.countdown === 0) {
                game.phase = STATE.PLAYING;
                AudioEngine.sfxGo();
                // mark start time for game duration timer
                game.startTime = Date.now();
                game.conditionsShown = false; // reset conditions overlay flag
                // SHOW PAUSE BUTTON
                document.getElementById('pause-btn').classList.remove('hidden');
            } else {
                game.countdownTimer = 60;
                AudioEngine.sfxBlip();
            }
        }
        return;
    }

    if (game.phase !== STATE.PLAYING) return;

    // End game if duration exceeded: pick winner by hits, tie-breaker lowest ducks
    if (game.startTime) {
        const elapsed = Date.now() - game.startTime;
        if (elapsed >= MAX_GAME_DURATION_MS) {
            // Choose winner among alive players by hits, tie-breaker ducks
            const alivePlayers = game.players.filter(p => p.alive);
            if (alivePlayers.length > 0) {
                let maxHits = Math.max(...alivePlayers.map(p => p.stats ? p.stats.hits : 0));
                let candidates = alivePlayers.filter(p => (p.stats ? p.stats.hits : 0) === maxHits);
                if (candidates.length > 1) {
                    // choose one with lowest duck count
                    let minDucks = Math.min(...candidates.map(p => p.stats ? p.stats.ducks : 0));
                    candidates = candidates.filter(p => (p.stats ? p.stats.ducks : 0) === minDucks);
                }
                // pick first candidate as winner
                endGame(candidates[0]);
                return;
            } else {
                endGame(null);
                return;
            }
        }
    }

    // PLAYING LOGIC

    let survivors = [];
    game.players.forEach(p => {
        p.updateGame();
        if (p.alive) survivors.push(p);
    });

    if (survivors.length <= 1) {
        endGame(survivors[0]);
        return;
    }

    // Periodic small speed boost to keep matches progressing (every 20s)
    if (game.startTime) {
        game.lastSpeedBoostTime = game.lastSpeedBoostTime || game.startTime;
        const now = Date.now();
        if (now - game.lastSpeedBoostTime >= SPEED_BOOST_INTERVAL_MS) {
            // apply boost to current ball speed magnitude, preserve sign
            game.ball.speed = Math.sign(game.ball.speed) * Math.min(Math.abs(game.ball.speed) * SPEED_BOOST_MULT, MAX_SPEED);
            game.lastSpeedBoostTime = now;
            // subtle feedback
            game.flash = Math.min(1, game.flash + 0.05);
        }
    }

    // Ball Movement
    game.ball.angle += game.ball.speed;
    game.ball.angle = (game.ball.angle + Math.PI * 2) % (Math.PI * 2);

    // Track Peak Speed & Player
    if (Math.abs(game.ball.speed) > game.ball.maxSpeed) {
        game.ball.maxSpeed = Math.abs(game.ball.speed);
        // Grab the name of the last person to hit it, or fallback if none
        game.ball.maxSpeedPlayer = game.ball.lastHitBy ? game.ball.lastHitBy.name : "The Void";
    }

    // ZONE LOGIC
    if (game.zones && game.zones.length > 0) {
        let inAnyZone = false;

        game.zones.forEach((z, index) => {
            // Normalize angles to 0-2PI for safe comparison
            let bAngle = game.ball.angle;
            let start = (z.start + Math.PI * 2) % (Math.PI * 2);
            let end = (z.end + Math.PI * 2) % (Math.PI * 2);

            // Check if ball is between start and end (handles wrapping past 0)
            let isInside = false;
            if (start < end) {
                isInside = (bAngle >= start && bAngle <= end);
            } else {
                isInside = (bAngle >= start || bAngle <= end);
            }

            if (isInside) {
                inAnyZone = true;
                // Only trigger the effect ONCE when entering the zone
                if (game.ball.activeZone !== index) {
                    game.ball.activeZone = index;

                    // Trigger Zone Effects
                    if (z.type === 'flip') {
                        game.ball.speed *= -1; // Reverse direction
                        AudioEngine.playTone(400, 'square', 0.1, 0.2); // Anomaly Sound
                        spawnParticles(game.ball.angle, '#ef4444', 20, true); // Red explosion
                        game.shake = 5; // Slight screen shake
                    } else if (z.type === 'portalIn') {
                        // Only the Orange portal triggers the teleport!
                        if (game.ball.portalsActive) {
                            let destPortal = game.zones[z.targetIndex];
                            let destCenter = (destPortal.start + destPortal.end) / 2;

                            game.ball.angle = destCenter;
                            game.ball.activeZone = z.targetIndex;
                            game.ball.portalsActive = false;

                            AudioEngine.playTone(800, 'sine', 0.1, 0.2);
                            spawnParticles(game.ball.angle, destPortal.color, 25, true);
                            game.shake = 8;
                        }
                    } else if (z.type === 'fast') {
                        // Multiply speed by 1.5x (cap at MAX_SPEED)
                        game.ball.speed = Math.sign(game.ball.speed) * Math.min(Math.abs(game.ball.speed) * 1.5, MAX_SPEED);

                        AudioEngine.playTone(600, 'square', 0.1, 0.1); // High pitch zip
                        spawnParticles(game.ball.angle, '#22c55e', 30, true);
                        game.flash = 0.2;
                    } else if (z.type === 'slow') {
                        // Cut speed by 40%, but never drop below the starting serve speed
                        const minSpeed = 0.015; // Roughly the START_SPEED
                        game.ball.speed = Math.sign(game.ball.speed) * Math.max(Math.abs(game.ball.speed) * 0.6, minSpeed);

                        AudioEngine.playTone(200, 'sine', 0.1, 0.3); // Low pitch heavy thud
                        spawnParticles(game.ball.angle, '#a855f7', 20, false); // Gentle particle poof
                    }
                }
            }
        });

        // Clear active zone if the ball has fully exited
        if (!inAnyZone) game.ball.activeZone = null;
    }

    // Trail
    game.ball.trail.push(game.ball.angle);
    if (game.ball.trail.length > 15) game.ball.trail.shift();

    // Collision
    game.players.forEach(p => {
        if (!p.alive) return;
        let diff = (game.ball.angle - p.angle + Math.PI * 3) % (Math.PI * 2) - Math.PI;

        // Reset per-approach flags when the ball is not near the player so we only
        // count one hit/duck per pass.
        if (Math.abs(diff) > 0.3) {
            p.duckedThisApproach = false;
            p.hitThisApproach = false;
        }

        if (Math.abs(diff) < 0.15) { // Hitbox
            if (p.isDucking) {
                // Dodge
                if (p.stats && !p.duckedThisApproach) {
                    p.stats.ducks++;
                    p.points += 10; // Dodge penalty
                    p.duckedThisApproach = true;
                    // Eliminate player if they accumulated too many ducks
                    if (p.stats.ducks >= DUCK_LIMIT) {
                        p.alive = false;
                        game.deadPlayers.push(p);
                        game.shake = 25;
                        game.flash = 0.9;
                        AudioEngine.sfxDie();
                        spawnParticles(p.angle, '#fff', 60, true);
                        const duckMsgs = ["wore out their knees", "spammed duck too hard", "quacked under pressure"];
                        const randomDuck = duckMsgs[Math.floor(Math.random() * duckMsgs.length)];
                        showKillfeedMessage(`🦆 <span style="color:${p.color}">${p.name}</span> ${randomDuck}!`);
                        // If this elimination left one or zero survivors, end the game
                        const survivorsNow = game.players.filter(pl => pl.alive);
                        if (survivorsNow.length <= 1) {
                            endGame(survivorsNow[0]);
                        }
                        return; // early return from this player's collision handling
                    }
                }
            } else if (p.swingTimer > 0) {
                // HIT SUCCESS
                // Count hit once per approach
                if (p.stats && !p.hitThisApproach) {
                    p.stats.hits++;
                    p.points += 25; // Base hit reward
                    p.hitThisApproach = true;
                }
                game.ball.portalsActive = true;
                // Check if the hit was perfectly timed in the center of the swing (swingTimer is between 6 and 9)
                const isPerfect = Math.abs(p.swingTimer - (SWING_DURATION / 2)) <= 1.5;

                game.ball.angle -= game.ball.speed * 2; // Eject from player

                if (isPerfect) {
                    // PERFECT STREAK MULTIPLIER
                    game.ball.perfectStreak++;
                    p.stats.perfects++; // <-- LEADERBOARD TRACKING: Count Perfects
                    const streakBonus = 50 * game.ball.perfectStreak;
                    p.points += streakBonus;

                    // PERFECT SMASH: Reverse direction and apply a massive speed multiplier
                    game.ball.speed = -Math.sign(game.ball.speed) * Math.min(Math.abs(game.ball.speed) * 1.15, MAX_SPEED * 1.2);
                    game.ball.color = '#facc15'; // Turn ball blazing Gold
                    game.shake = 20;
                    game.flash = 0.6;
                    AudioEngine.sfxHit();
                    AudioEngine.playTone(150, 'sawtooth', 0.3, 0.2); // Extra bass boom!
                    spawnParticles(p.angle, '#facc15', 30, true); // Golden sparks

                    // Spawn the Fire Emoji for both Humans and Bots!
                    spawnParticles(p.angle, null, 0, false, "🔥");
                } else {
                    // NORMAL HIT
                    game.ball.perfectStreak = 0; // reset perfect streak
                    game.ball.speed = -game.ball.speed * SPEED_INC;
                    if (Math.abs(game.ball.speed) > MAX_SPEED) {
                        game.ball.speed = MAX_SPEED * Math.sign(game.ball.speed);
                    }
                    game.ball.color = p.color;
                    game.shake = 8;
                    game.flash = 0.3;
                    AudioEngine.sfxHit();
                    spawnParticles(p.angle, p.color, 15);
                }
                // Tag the ball with this player's ID for kill credit
                game.ball.lastHitBy = p;
            } else {
                // DEATH
                p.alive = false;
                p.points -= 50; // Death penalty
                game.deadPlayers.push(p); // <-- LEADERBOARD TRACKING: Record death
                game.shake = 25;
                game.flash = 0.8;
                AudioEngine.sfxDie();
                spawnParticles(p.angle, '#fff', 40, true);

                // Add Death Emote for Bots
                if (p.isBot) {
                    const deathIcon = Math.random() > 0.5 ? "💀" : "❓";
                    spawnParticles(p.angle, null, 0, false, deathIcon);
                }
                // --- KILLFEED GENERATOR ---
                let deathReason = p.cooldown > 0 ? "whiffed the swing" : "fell asleep at the wheel";

                // Colorize the names based on the player's assigned hex color
                let victimText = `<span style="color:${p.color}">${p.name}</span>`;
                let killerText = game.ball.lastHitBy ? `<span style="color:${game.ball.lastHitBy.color}">${game.ball.lastHitBy.name}</span>` : "The Void";

                let killMessage = "";
                if (game.ball.lastHitBy === p) {
                    killMessage = `🤡 ${victimText} hit the self-destruct button!`;
                } else if (game.ball.lastHitBy) {
                    // Randomize the flavor text!
                    const killVerbs = ["obliterated", "dismantled", "gapped", "deleted"];
                    const randomVerb = killVerbs[Math.floor(Math.random() * killVerbs.length)];

                    // The reason is slightly smaller and greyed out to reduce clutter
                    killMessage = `⚔️ ${killerText} ${randomVerb} ${victimText} <span style="color:#94a3b8; font-size:12px;">(${deathReason})</span>`;

                    game.ball.lastHitBy.points += 100;
                    game.ball.lastHitBy.stats.kills++;
                } else {
                    killMessage = `💨 ${victimText} died to the starting serve <span style="color:#94a3b8; font-size:12px;">(${deathReason})</span>`;
                }

                // Push to HTML killfeed
                showKillfeedMessage(killMessage);
            }
        }
    });

    // Particle Update
    game.particles.forEach(p => {
        p.x += p.vx; p.y += p.vy; p.life -= p.text ? 0.015 : 0.04;
    });
    game.particles = game.particles.filter(p => p.life > 0);

}

function draw() {
    ctx.fillStyle = '#020617';
    ctx.fillRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);

    // Dynamic Stars
    ctx.save();
    ctx.translate(CANVAS_SIZE / 2, CANVAS_SIZE / 2);
    ctx.rotate(Date.now() * 0.0002);
    game.stars.forEach(s => {
        ctx.fillStyle = `rgba(255, 255, 255, ${s.alpha})`;
        ctx.beginPath(); ctx.arc(s.x - CANVAS_SIZE / 2, s.y - CANVAS_SIZE / 2, s.size, 0, Math.PI * 2); ctx.fill();
    });
    ctx.restore();

    // Shake
    ctx.save();
    const dx = (Math.random() - 0.5) * game.shake;
    const dy = (Math.random() - 0.5) * game.shake;
    ctx.translate(dx, dy);

    // Track Ring
    ctx.beginPath(); ctx.arc(CANVAS_SIZE / 2, CANVAS_SIZE / 2, BASE_RADIUS, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255,255,255,0.1)'; ctx.lineWidth = 2; ctx.stroke();

    // Draw Zones with Custom Animations
    if (game.zones && game.zones.length > 0) {
        const time = Date.now();

        game.zones.forEach((z, index) => {
            ctx.save();

            // 1. Draw the translucent base track (Very low opacity so ball is visible!)
            ctx.beginPath();
            ctx.arc(CANVAS_SIZE / 2, CANVAS_SIZE / 2, BASE_RADIUS, z.start, z.end);

            // Dim portals if inactive
            if ((z.type === 'portalIn' || z.type === 'portalOut') && !game.ball.portalsActive) {
                ctx.strokeStyle = 'rgba(71, 85, 105, 0.2)';
            } else {
                ctx.strokeStyle = z.color;
                ctx.globalAlpha = 0.25;
            }

            ctx.lineWidth = 14;
            ctx.lineCap = 'round';
            ctx.stroke();

            // 2. Custom Animations (No dashed lines!)
            ctx.globalAlpha = 1.0;
            let span = z.end - z.start;

            if (z.type === 'flip') {
                // A thin, violently pulsing red line in the center
                ctx.beginPath();
                ctx.arc(CANVAS_SIZE / 2, CANVAS_SIZE / 2, BASE_RADIUS, z.start, z.end);
                ctx.strokeStyle = '#ef4444';
                ctx.lineWidth = 1 + Math.abs(Math.sin(time / 100)) * 3; // Pulses thickness
                ctx.stroke();
            }
            else if (z.type === 'portalIn' || z.type === 'portalOut') {
                // Draw 3 animated nodes
                let numIcons = 3;
                for (let i = 1; i <= numIcons; i++) {
                    let angle = z.start + span * (i / (numIcons + 1));
                    let tx = CANVAS_SIZE / 2 + Math.cos(angle) * BASE_RADIUS;
                    let ty = CANVAS_SIZE / 2 + Math.sin(angle) * BASE_RADIUS;

                    ctx.save();
                    ctx.translate(tx, ty);

                    // Create looping Shrink/Grow animations based on the type
                    let scale = 1.0;
                    if (game.ball.portalsActive) {
                        let cycle = (time / 300 + i / numIcons) % 1.0;
                        if (z.type === 'portalIn') {
                            scale = 1.0 - cycle; // Sucks inward (shrinks to 0)
                        } else {
                            scale = cycle; // Spits outward (grows from 0)
                        }
                    } else {
                        scale = 0.5; // Static size when on cooldown
                    }

                    ctx.scale(scale, scale);

                    ctx.beginPath();
                    ctx.arc(0, 0, 4, 0, Math.PI * 2);

                    // Color the dots Orange/Blue instead of White to reinforce identity
                    ctx.fillStyle = game.ball.portalsActive ? z.color : '#475569';
                    ctx.shadowColor = game.ball.portalsActive ? z.color : 'transparent';
                    ctx.shadowBlur = 10;
                    ctx.fill();
                    ctx.restore();
                }
            }
            else if (z.type === 'fast' || z.type === 'slow') {
                // Draw 3 animated icons inside the zone
                let numIcons = 3;
                for (let i = 1; i <= numIcons; i++) {
                    let angle = z.start + span * (i / (numIcons + 1));
                    let tx = CANVAS_SIZE / 2 + Math.cos(angle) * BASE_RADIUS;
                    let ty = CANVAS_SIZE / 2 + Math.sin(angle) * BASE_RADIUS;

                    ctx.save();
                    ctx.translate(tx, ty);
                    ctx.rotate(angle + Math.PI / 2); // Align with the track

                    let bounce = Math.sin(time / 150 + i) * 3; // Bobbing up and down animation
                    ctx.translate(0, bounce);

                    ctx.beginPath();
                    ctx.lineWidth = 2;
                    if (z.type === 'fast') {
                        // Forward-facing arrows (Chevrons)
                        ctx.strokeStyle = '#4ade80';
                        ctx.moveTo(-4, 0); ctx.lineTo(0, -5); ctx.lineTo(4, 0);
                        ctx.stroke();
                    } else {
                        // Heavy blocks (Brakes) for slow zones
                        ctx.fillStyle = '#a855f7';
                        ctx.fillRect(-3, -3, 6, 6);
                    }
                    ctx.restore();
                }
            }

            ctx.restore();
        });
    }

    // Draw Entities
    game.players.forEach(p => p.draw(ctx, game.phase === STATE.LOBBY));

    // Draw Ball
    if (game.phase === STATE.PLAYING || game.phase === STATE.COUNTDOWN || game.phase === STATE.PAUSED) {
        if (game.ball.trail && game.ball.trail.length > 1) {
            ctx.beginPath();
            game.ball.trail.forEach((ang, i) => {
                const tx = CANVAS_SIZE / 2 + Math.cos(ang) * BASE_RADIUS;
                const ty = CANVAS_SIZE / 2 + Math.sin(ang) * BASE_RADIUS;
                if (i === 0) ctx.moveTo(tx, ty); else ctx.lineTo(tx, ty);
            });
            ctx.lineCap = 'round'; ctx.lineWidth = 4; ctx.strokeStyle = game.ball.color;
            ctx.globalAlpha = 0.3; ctx.stroke(); ctx.globalAlpha = 1.0;
        }

        const bx = CANVAS_SIZE / 2 + Math.cos(game.ball.angle) * BASE_RADIUS;
        const by = CANVAS_SIZE / 2 + Math.sin(game.ball.angle) * BASE_RADIUS;
        ctx.fillStyle = game.ball.color; ctx.shadowColor = game.ball.color; ctx.shadowBlur = 20;
        ctx.beginPath(); ctx.arc(bx, by, 6, 0, Math.PI * 2); ctx.fill(); ctx.shadowBlur = 0;
    }

    // Particles & Emotes
    game.particles.forEach(p => {
        ctx.globalAlpha = p.life > 1 ? 1 : p.life; // Handle longer life for emotes

        if (p.text) {
            // Draw Emoji/Text
            ctx.font = "24px Arial";
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.fillText(p.text, p.x, p.y);
        } else {
            // Draw standard circle particle
            ctx.fillStyle = p.color;
            ctx.beginPath();
            ctx.arc(p.x, p.y, 3, 0, Math.PI * 2);
            ctx.fill();
        }
    });
    ctx.globalAlpha = 1.0;

    // Flash
    if (game.flash > 0.01) {
        ctx.fillStyle = `rgba(255,255,255,${game.flash})`;
        ctx.fillRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);
    }

    ctx.restore();

    // OVERLAY TEXT FOR UI
    ctx.save();
    ctx.translate(CANVAS_SIZE / 2, CANVAS_SIZE / 2);

    if (game.phase === STATE.LOBBY) {
        ctx.font = "bold 20px 'Segoe UI', sans-serif";
        ctx.fillStyle = "#fff"; ctx.textAlign = "center";
        ctx.shadowColor = "rgba(0,0,0,0.8)"; ctx.shadowBlur = 5;

        ctx.fillText("WAITING FOR PLAYERS...", 0, -30);
        ctx.font = "16px sans-serif"; ctx.fillStyle = "#06b6d4";
        ctx.fillText("PRESS 'HIT' KEY TO READY UP", 0, 0);

        const readyCount = game.players.filter(p => p.ready).length;
        ctx.font = "bold 24px sans-serif";
        ctx.fillStyle = readyCount === game.totalPlayers ? "#22c55e" : "#f8fafc";
        ctx.fillText(`${readyCount} / ${game.totalPlayers}`, 0, 40);
    }
    else if (game.phase === STATE.COUNTDOWN) {
        ctx.font = "900 120px sans-serif";
        ctx.fillStyle = "#fff"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
        ctx.shadowColor = "#06b6d4"; ctx.shadowBlur = 30;
        ctx.fillText(game.countdown, 0, 0);
    }
    ctx.restore();

    // Game Timer - top center
    if ((game.phase === STATE.PLAYING || game.phase === STATE.PAUSED) && game.startTime) {
        const elapsedMs = Date.now() - game.startTime;
        const seconds = Math.floor(elapsedMs / 1000) % 60;
        const minutes = Math.floor(elapsedMs / 60000);
        const timeStr = `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
        ctx.save();
        ctx.font = "700 18px 'Segoe UI', sans-serif";
        ctx.fillStyle = '#fff';
        ctx.textAlign = 'center';
        ctx.shadowColor = '#06b6d4'; ctx.shadowBlur = 12;
        ctx.fillText(timeStr, CANVAS_SIZE / 2, 30);
        ctx.restore();

        // Show end-game conditions overlay at 5 minutes
        if (minutes >= 5 && !game.conditionsShown) {
            game.conditionsShown = true;
            game.conditionsShowTime = Date.now();
        }

        if (game.conditionsShown) {
            const conditionsDuration = 20000; // show for 20 seconds
            const timeSinceShow = Date.now() - game.conditionsShowTime;
            if (timeSinceShow < conditionsDuration) {
                const fadeAlpha = Math.max(0, 1 - (timeSinceShow / conditionsDuration) * 0.5);
                ctx.save();
                ctx.translate(CANVAS_SIZE / 2, CANVAS_SIZE / 2);

                // Semi-transparent dark background box
                ctx.fillStyle = `rgba(2, 6, 23, 0.85)`;
                ctx.strokeStyle = 'rgba(6, 182, 212, 0.4)';
                ctx.lineWidth = 2;
                ctx.beginPath();
                ctx.roundRect(-120, -80, 240, 160, 10);
                ctx.fill();
                ctx.stroke();

                // Title
                ctx.font = "bold 18px 'Segoe UI', sans-serif";
                ctx.fillStyle = `rgba(6, 182, 212, ${fadeAlpha})`;
                ctx.textAlign = 'center';
                ctx.shadowColor = 'rgba(6, 182, 212, 0.8)';
                ctx.shadowBlur = 8;
                ctx.fillText('GAME CONDITIONS', 0, -50);

                // Conditions text
                ctx.font = "14px 'Segoe UI', sans-serif";
                ctx.fillStyle = `rgba(255, 255, 255, ${fadeAlpha * 0.9})`;
                ctx.shadowColor = 'rgba(0, 0, 0, 0.8)';
                ctx.shadowBlur = 4;
                ctx.fillText('Time Limit: 10 Minutes', 0, -20);
                ctx.fillText('Duck Limit: 2000', 0, 5);
                ctx.fillText('Reach limit → Eliminated', 0, 30);

                ctx.shadowBlur = 0;
                ctx.restore();
            }
        }
    }
}

function loop() {
    if (game.phase !== STATE.MENU) {
        update();
        draw();
        animationId = requestAnimationFrame(loop);
    }
}

function reshuffleZones() {
    game.zones = [];
    if (game.mode === 'standard') return;

    const slice = (Math.PI * 2) / game.totalPlayers;
    let availableGaps = [];

    for (let i = 0; i < game.totalPlayers; i++) {
        let gapCenter = (slice * i) + (slice / 2);
        let diff = (game.ball.angle - gapCenter + Math.PI * 3) % (Math.PI * 2) - Math.PI;
        if (Math.abs(diff) > 1.2) availableGaps.push(i);
    }

    if (availableGaps.length === 0) {
        for (let i = 0; i < game.totalPlayers; i++) availableGaps.push(i);
    }
    availableGaps.sort(() => Math.random() - 0.5);

    // FIX: Hard-cap the width to 0.5 radians maximum so they are always small!
    let w = Math.min(0.5, slice - 0.3);

    if (game.mode === 'flip') {
        let numZones = Math.min(availableGaps.length, Math.random() > 0.5 ? 2 : 1);
        for (let i = 0; i < numZones; i++) {
            let gapIndex = availableGaps[i];
            let center = (slice * gapIndex) + (slice / 2);
            game.zones.push({ type: 'flip', start: center - (w / 2), end: center + (w / 2), color: 'rgba(239, 68, 68, 1.0)' });
        }
    } else if (game.mode === 'portal' && availableGaps.length >= 2) {
        let center1 = (slice * availableGaps[0]) + (slice / 2);
        let center2 = (slice * availableGaps[1]) + (slice / 2);

        // Orange is STRICTLY the ENTRANCE (portalIn)
        game.zones.push({ type: 'portalIn', targetIndex: 1, start: center1 - (w / 2), end: center1 + (w / 2), color: 'rgba(249, 115, 22, 1.0)' });

        // Blue is STRICTLY the EXIT (portalOut). It has no target because it doesn't teleport anything.
        game.zones.push({ type: 'portalOut', targetIndex: null, start: center2 - (w / 2), end: center2 + (w / 2), color: 'rgba(56, 189, 248, 1.0)' });
    } else if (game.mode === 'speed') {
        // Spawn 1 or 2 zones randomly
        let numZones = Math.min(availableGaps.length, Math.random() > 0.5 ? 2 : 1);
        for (let i = 0; i < numZones; i++) {
            let gapIndex = availableGaps[i];
            let center = (slice * gapIndex) + (slice / 2);

            // Randomly decide if this specific zone is Fast or Slow
            let isFast = Math.random() > 0.5;

            game.zones.push({
                type: isFast ? 'fast' : 'slow',
                start: center - (w / 2),
                end: center + (w / 2),
                color: isFast ? 'rgba(34, 197, 94, 1.0)' : 'rgba(168, 85, 247, 1.0)'
            });
        }
    } else if (game.mode === 'chaos') {
        // Track the array index so the portals know how to link to each other
        let currentIndex = 0;

        // 1. Throw in a Flip Zone if we have space
        if (availableGaps.length > 0) {
            let gap = availableGaps.pop(); // Take a random gap out of the available pool
            let center = (slice * gap) + (slice / 2);
            game.zones.push({ type: 'flip', start: center - (w / 2), end: center + (w / 2), color: 'rgba(239, 68, 68, 1.0)' });
            currentIndex++;
        }

        // 2. Throw in a random Speed or Slow zone if we have space
        if (availableGaps.length > 0) {
            let gap = availableGaps.pop();
            let center = (slice * gap) + (slice / 2);
            let isFast = Math.random() > 0.5;
            game.zones.push({
                type: isFast ? 'fast' : 'slow',
                start: center - (w / 2), end: center + (w / 2),
                color: isFast ? 'rgba(34, 197, 94, 1.0)' : 'rgba(168, 85, 247, 1.0)'
            });
            currentIndex++;
        }

        // 3. Throw in a Portal Pair if we have at least 2 empty gaps left!
        if (availableGaps.length >= 2) {
            let gap1 = availableGaps.pop();
            let gap2 = availableGaps.pop();
            let c1 = (slice * gap1) + (slice / 2);
            let c2 = (slice * gap2) + (slice / 2);

            // The Entrance targets the Exit, which will be the very next item added to the array
            game.zones.push({ type: 'portalIn', targetIndex: currentIndex + 1, start: c1 - (w / 2), end: c1 + (w / 2), color: 'rgba(249, 115, 22, 1.0)' });
            game.zones.push({ type: 'portalOut', targetIndex: null, start: c2 - (w / 2), end: c2 + (w / 2), color: 'rgba(56, 189, 248, 1.0)' });
        }
    }
    if (game.ball) game.ball.portalsActive = true;
    game.flash = 0.15;
}

// --- UI HELPERS ---

function adjustTotal(delta) {
    game.totalPlayers += delta;
    if (game.totalPlayers < 2) game.totalPlayers = 2;
    if (game.totalPlayers > 8) game.totalPlayers = 8;
    if (game.humanCount > game.totalPlayers) game.humanCount = game.totalPlayers;
    updateUIDisplay();
}

function adjustHumans(delta) {
    game.humanCount += delta;
    if (game.humanCount < 0) game.humanCount = 0;
    if (game.humanCount > game.totalPlayers) game.humanCount = game.totalPlayers;
    updateUIDisplay();
}

function updateUIDisplay() {
    document.getElementById('total-display').innerText = game.totalPlayers;
    document.getElementById('human-display').innerText = game.humanCount;
}

function goToLobby() {
    AudioEngine.init();
    game.difficulty = document.getElementById('bot-difficulty').value;
    game.mode = document.getElementById('game-mode').value;
    uiMenu.classList.add('hidden');
    uiGameOver.classList.add('hidden');

    game.phase = STATE.LOBBY;
    game.players = [];
    game.deadPlayers = [];
    game.particles = [];
    game.shake = 0;

    document.getElementById('name-setup-screen').classList.add('hidden'); // Hide setup screen

    const slice = (Math.PI * 2) / game.totalPlayers;
    for (let i = 0; i < game.totalPlayers; i++) {
        const isBot = i >= game.humanCount;

        // Grab the name from the input field
        const inputField = document.getElementById(`name-input-${i}`);
        let assignedName = inputField ? inputField.value.trim() : "";

        // If left empty, use the default from the arrays
        if (!assignedName) {
            assignedName = isBot ? BOT_NAMES[i % BOT_NAMES.length] : HUMAN_NAMES[i % HUMAN_NAMES.length];
        }

        const newPlayer = new Player(i, slice * i, isBot);
        newPlayer.name = assignedName; // Attach name to the player object
        game.players.push(newPlayer);
    }

    // Calculate the exact midpoint between two random players for a perfectly fair spawn
    const randomGapIndex = Math.floor(Math.random() * game.totalPlayers);
    // Spawn exactly halfway between the chosen player and the next player
    const safeAngle = (slice * randomGapIndex) + (slice / 2);

    game.ball = {
        angle: safeAngle,
        speed: Math.random() > 0.5 ? START_SPEED : -START_SPEED,
        color: '#fff',
        trail: [],
        lastHitBy: null, // Tracks who gets the kill credit
        perfectStreak: 0, // Tracks back-to-back perfect hits
        activeZone: null, // Tracks if the ball is currently inside a zone to prevent infinite flipping
        maxSpeed: START_SPEED, //Tracks the peak speed reached for end-game stats
        maxSpeedPlayer: null //Tracks the record holder
    };
    game.killfeed = []; // Initialize the empty killfeed array

    // SETUP ZONES
    // --- SETUP ZONES ---
    game.zoneTimer = 0; // Initialize the shifting timer
    reshuffleZones(); // Immediately spawn the first setup

    if (animationId) {
        cancelAnimationFrame(animationId);
    }

    loop();
}

function endGame(winner) {
    document.getElementById('pause-btn').classList.add('hidden');
    game.phase = STATE.GAMEOVER;
    AudioEngine.sfxWin();

    const text = document.getElementById('winner-text');
    if (winner) {
        text.innerHTML = `<span style="color:${winner.color}">${winner.name.toUpperCase()} WINS</span>`;
    } else {
        text.innerText = "DRAW";
        text.style.color = "#fff";
    }

    // --- BUILD LEADERBOARD ---
    // deadPlayers logs from first death to last. We reverse it so the last to die is at the top.
    let leaderboard = [...game.deadPlayers].reverse();
    if (winner) leaderboard.unshift(winner); // Put the winner in 1st place!

    const tbody = document.getElementById('leaderboard-body');
    tbody.innerHTML = ''; // Clear previous stats

    leaderboard.forEach((p, index) => {
        const row = document.createElement('tr');
        row.style.borderBottom = "1px solid #1e293b";
        row.innerHTML = `
            <td style="padding: 8px; color: ${p.color}; font-weight: bold;">${index + 1}</td>
            <td style="padding: 8px; color: ${p.color};">${p.name}</td>
            <td style="padding: 8px; color: #facc15; font-weight: bold;">${p.points}</td>
            <td style="padding: 8px;">${p.stats.kills}</td>
            <td style="padding: 8px;">${p.stats.perfects}</td>
            <td style="padding: 8px;">${p.stats.ducks}</td>
        `;
        tbody.appendChild(row);
    });

    // --- POPULATE METRICS CARD ---
    const speedKmh = Math.round(game.ball.maxSpeed * 4000);
    document.getElementById('max-speed-display').innerText = `${speedKmh} km/h`;
    document.getElementById('max-speed-player').innerText = game.ball.maxSpeedPlayer || "None";

    // Calculate how close they got to the game's absolute MAX_SPEED limit (percentage)
    const speedPercent = Math.min(100, (game.ball.maxSpeed / MAX_SPEED) * 100);

    // Reset bar to 0 first, then animate it up for a cool visual effect
    const speedBar = document.getElementById('max-speed-bar');
    speedBar.style.transition = 'none';
    speedBar.style.width = '0%';
    setTimeout(() => {
        speedBar.style.transition = 'width 1.5s cubic-bezier(0.34, 1.56, 0.64, 1)'; // Bouncy easing
        speedBar.style.width = `${speedPercent}%`;
    }, 100);

    // Ensure the leaderboard is hidden when the screen first appears
    document.getElementById('leaderboard-container').style.display = 'none';

    setTimeout(() => {
        uiGameOver.classList.remove('hidden');

        // Anime.js Elastic Pop for the Winner Text
        anime({
            targets: '#winner-text',
            scale: [0.5, 1],
            rotate: [-5, 0],
            opacity: [0, 1],
            easing: 'easeOutElastic(1, .4)', // High elasticity for a big bounce
            duration: 1200
        });
    }, 1000);
}

function toggleStats() {
    const container = document.getElementById('leaderboard-container');
    if (container.style.display === 'none') {
        container.style.display = 'block';

        // Anime.js Cascade effect for leaderboard rows
        anime({
            targets: '#leaderboard-body tr',
            translateX: [30, 0],
            opacity: [0, 1],
            delay: anime.stagger(50), // Rapid fire 50ms stagger
            easing: 'easeOutQuad',
            duration: 400
        });
    } else {
        container.style.display = 'none';
    }
}

function showMenu() {
    uiGameOver.classList.add('hidden');
    uiMenu.classList.remove('hidden');
    ctx.clearRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);
    document.getElementById('pause-btn').classList.add('hidden');
    document.getElementById('pause-screen').classList.add('hidden'); // Just in case
    document.getElementById('name-setup-screen').classList.add('hidden');
}

function togglePause() {
    if (game.phase === STATE.PLAYING) {
        game.phase = STATE.PAUSED;
        game.pauseStartTime = Date.now(); // Record when we paused to fix the timer later
        document.getElementById('pause-screen').classList.remove('hidden');
        document.getElementById('pause-btn').classList.add('hidden');
    } else if (game.phase === STATE.PAUSED) {
        game.phase = STATE.PLAYING;
        // Shift the game start time forward by the amount of time we spent paused
        game.startTime += (Date.now() - game.pauseStartTime);
        if (game.lastSpeedBoostTime) game.lastSpeedBoostTime += (Date.now() - game.pauseStartTime);

        document.getElementById('pause-screen').classList.add('hidden');
        document.getElementById('pause-btn').classList.remove('hidden');
    }
}

function restartGame() {
    document.getElementById('pause-screen').classList.add('hidden');
    // Hide the pause button until countdown finishes again
    document.getElementById('pause-btn').classList.add('hidden');
    goToLobby(); // Sends them right back to the lobby with current settings
}

function showKillfeedMessage(htmlText) {
    const container = document.getElementById('killfeed-ui');
    if (!container) return;

    const msg = document.createElement('div');
    msg.className = 'kill-msg';
    msg.innerHTML = htmlText;
    container.appendChild(msg);

    // Fade out and remove after 3 seconds
    setTimeout(() => {
        msg.style.opacity = '0';
        setTimeout(() => msg.remove(), 500);
    }, 3000);
}

function showNameSetup() {
    // Hide menu, show name setup
    uiMenu.classList.add('hidden');
    document.getElementById('name-setup-screen').classList.remove('hidden');

    const container = document.getElementById('name-inputs-container');
    container.innerHTML = ''; // Clear old inputs

    // Generate rows
    for (let i = 0; i < game.totalPlayers; i++) {
        const isBot = i >= game.humanCount;
        const defaultName = isBot ? BOT_NAMES[i % BOT_NAMES.length] : HUMAN_NAMES[i % HUMAN_NAMES.length];
        const label = isBot ? `BOT ${i + 1}` : `P${i + 1}`;
        const color = COLORS[i];

        container.innerHTML += `
            <div class="name-row">
                <div class="color-dot" style="background: ${color}; box-shadow: 0 0 8px ${color}"></div>
                <div style="width: 50px; font-weight: bold; color: #cbd5e1; font-size: 0.9rem;">${label}</div>
                <input type="text" id="name-input-${i}" class="name-input" placeholder="${defaultName}">
            </div>
        `;
    }

    // Anime.js Stagger effect for the input rows
    anime({
        targets: '.name-row',
        translateX: [-50, 0],
        opacity: [0, 1],
        delay: anime.stagger(100), // 100ms delay between each row
        easing: 'easeOutElastic(1, .8)', // Springy snap
        duration: 800
    });
}

updateUIDisplay();

// --- ANIME.JS UI ANIMATIONS ---

// 1. Idle Menu Pulse (Runs immediately on load)
anime({
    targets: '#menu-screen h1',
    scale: [1, 1.05],
    textShadow: ['0 0 20px #06b6d4', '0 0 40px #06b6d4', '0 0 20px #06b6d4'],
    duration: 2000,
    direction: 'alternate',
    loop: true,
    easing: 'easeInOutSine'
});
/* --- JS END --- */