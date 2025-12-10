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
const MAX_SPEED = 3.0;
// Reduce speed increment per hit so games last longer; adjust to taste (1.0 = no change)
const SPEED_INC = 1.04;
// Periodic speed boost: every SPEED_BOOST_INTERVAL_MS multiply ball speed by SPEED_BOOST_MULT
const SPEED_BOOST_INTERVAL_MS = 20000; // 20 seconds
const SPEED_BOOST_MULT = 1.1; // small incremental boost
// Game end rules
const MAX_GAME_DURATION_MS = 10 * 60 * 1000; // 10 minutes
const DUCK_LIMIT = 2000; // ducks needed to eliminate a player
const SWING_DURATION = 15;
const COOLDOWN = 30;
// How long a bot will stay ducked (in frames) after choosing to duck
const DUCK_HOLD = 30;

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
    GAMEOVER: 4
};

let game = {
    phase: STATE.MENU,
    totalPlayers: 4,
    humanCount: 1,
    difficulty: 'medium',
    players: [],
    ball: {},
    particles: [],
    stars: [],
    shake: 0,
    flash: 0,
    countdown: 3,
    countdownTimer: 0
    , tick: 0
};

let keys = {};

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
        this.stats = { hits: 0, ducks: 0 };
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
            // Bots: if bot decided to duck, give them a short hold period so they
            // don't unduck immediately while the ball is still passing.
            if (wantDuck && this.swingTimer === 0) {
                this.duckTimer = Math.max(this.duckTimer, DUCK_HOLD);
            }
            this.isDucking = (this.duckTimer > 0);
        } else {
            // Humans: duck while the key is held and swingTimer is not active
            if (wantDuck && this.swingTimer === 0) this.isDucking = true; else this.isDucking = false;
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
        // Panic duck if we just swung (on cooldown) and impact is very soon.
        // Reduce panic-duck frequency for non-impossible difficulties so bots don't
        // overuse panic ducks as the game progresses.
        if (this.cooldown > 0 && framesToImpact < 12) {
            const panicMultiplier = (game.difficulty === 'impossible') ? 1.0 : 0.5;
            const effectiveDuckChance = (this.profile.duckChance || 0) * panicMultiplier;
            if (Math.random() < effectiveDuckChance) {
                this.botState.ducking = true;
                this.actionColor = '#facc15';
                this.actionTimer = 5;
            }
        }

        // Strategic duck for very fast balls (except impossible difficulty)
        if (!this.botState.ducking && game.difficulty !== 'impossible' && Math.abs(ball.speed) > 0.14 && framesToImpact < 20) {
            if (Math.random() < 0.02) this.botState.ducking = true;
        }

        if (this.botState.ducking) {
            result.duck = true;
            return result;
        }

        // --- HIT LOGIC ---
        // Start swing early enough so swingTimer > 0 when impact occurs.
        // Use SWING_DURATION as the window in which the bot will attempt a hit,
        // and apply a probability based on difficulty and perceived timing.
        // Widen action window so bots can pick (hit vs duck) earlier rather than only
        // when the ball is right on top of them.
        if (perceivedFrames <= SWING_DURATION * 1.4) {
            // Determine effective hit probability (timing + difficulty + speed)
            const baseHit = this.profile.hitChance || 0.5;
            const swingCenter = SWING_DURATION / 2;
            const proximity = Math.max(0, 1 - (Math.abs(perceivedFrames - swingCenter) / swingCenter));
            let finalHitProb = baseHit * (0.5 + 0.5 * proximity);
            const speedFactor = Math.max(0.45, 1 - (Math.abs(ball.speed) / MAX_SPEED) * 0.6);
            finalHitProb *= speedFactor;
            finalHitProb = Math.min(Math.max(finalHitProb, 0), 0.99);

            // Determine duck probability (use profile.duckChance as base)
            let duckProb = this.profile.duckChance || 0.2;
            // Slightly increase duck probability if ball is very fast
            if (Math.abs(ball.speed) > 0.14) duckProb = Math.min(0.99, duckProb + 0.05);

            // For impossible bots, act almost always (either hit or duck)
            if (this.profile.hitChance >= 0.95 && duckProb >= 0.95) {
                // Randomly choose hit or duck but almost certainly do one
                if (Math.random() < 0.5) {
                    result.hit = true;
                    this.actionColor = '#ffffff';
                } else {
                    result.duck = true;
                    this.actionColor = '#facc15';
                }
                this.actionTimer = 5;
                return result;
            }

            // Normalize and randomly choose between duck and hit to add asymmetry
            const total = finalHitProb + duckProb;
            if (total <= 0) {
                // fallback: try to hit if nothing else
                if (Math.random() < finalHitProb) {
                    result.hit = true; this.actionColor = '#ffffff'; this.actionTimer = 5;
                }
            } else {
                const pick = Math.random() * total;
                if (pick < duckProb) {
                    result.duck = true;
                    this.actionColor = '#facc15';
                    this.actionTimer = 5;
                } else {
                    result.hit = true;
                    this.actionColor = '#ffffff';
                    this.actionTimer = 5;
                }
            }
        }

        // Safety: ensure we never return both actions true (mutual exclusivity)
        // (This is defensive; main code should already avoid this.)
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
                ctx.fillText("BOT", tx, ty);
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
            ctx.fillStyle = "#cbd5e1";
            ctx.textAlign = "center";
            ctx.textBaseline = "bottom";
            const hitsG = this.stats ? this.stats.hits : 0;
            const ducksG = this.stats ? this.stats.ducks : 0;
            // draw slightly above the player (before rotating the player body)
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
            ctx.arc(0, -20, 22, Math.PI - (progress * Math.PI), 2 * Math.PI - (progress * Math.PI));
            ctx.stroke();
        }

        ctx.restore();
    }
}

// --- CORE FUNCTIONS ---

function spawnParticles(angle, color, count, explosive = false) {
    const cx = CANVAS_SIZE / 2 + Math.cos(angle) * BASE_RADIUS;
    const cy = CANVAS_SIZE / 2 + Math.sin(angle) * BASE_RADIUS;
    for (let i = 0; i < count; i++) {
        game.particles.push({
            x: cx, y: cy,
            vx: (Math.random() - 0.5) * (explosive ? 15 : 5),
            vy: (Math.random() - 0.5) * (explosive ? 15 : 5),
            life: 1.0,
            color: color
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

    // --- PLAYING LOGIC ---

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
                // Dodge successful, count duck once per approach and do nothing
                if (p.stats && !p.duckedThisApproach) {
                    p.stats.ducks++;
                    p.duckedThisApproach = true;
                    // Eliminate player if they accumulated too many ducks
                    if (p.stats.ducks >= DUCK_LIMIT) {
                        p.alive = false;
                        game.shake = 25;
                        game.flash = 0.9;
                        AudioEngine.sfxDie();
                        spawnParticles(p.angle, '#fff', 60, true);
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
                    p.hitThisApproach = true;
                }
                game.ball.angle -= game.ball.speed * 2;
                game.ball.speed = -game.ball.speed * SPEED_INC;

                if (Math.abs(game.ball.speed) > MAX_SPEED) {
                    game.ball.speed = MAX_SPEED * Math.sign(game.ball.speed);
                }

                game.ball.color = p.color;
                game.shake = 8;
                game.flash = 0.3;
                AudioEngine.sfxHit();
                spawnParticles(p.angle, p.color, 15);
            } else {
                // DEATH
                p.alive = false;
                game.shake = 25;
                game.flash = 0.8;
                AudioEngine.sfxDie();
                spawnParticles(p.angle, '#fff', 40, true);
            }
        }
    });

    // Particle Update
    game.particles.forEach(p => {
        p.x += p.vx; p.y += p.vy; p.life -= 0.04;
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

    // Draw Entities
    game.players.forEach(p => p.draw(ctx, game.phase === STATE.LOBBY));

    // Draw Ball
    if (game.phase === STATE.PLAYING || game.phase === STATE.COUNTDOWN) {
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

    // Particles
    game.particles.forEach(p => {
        ctx.globalAlpha = p.life; ctx.fillStyle = p.color;
        ctx.beginPath(); ctx.arc(p.x, p.y, 3, 0, Math.PI * 2); ctx.fill();
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
    if (game.phase === STATE.PLAYING && game.startTime) {
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
        requestAnimationFrame(loop);
    }
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
    uiMenu.classList.add('hidden');
    uiGameOver.classList.add('hidden');

    game.phase = STATE.LOBBY;
    game.players = [];
    game.particles = [];
    game.shake = 0;

    const slice = (Math.PI * 2) / game.totalPlayers;
    for (let i = 0; i < game.totalPlayers; i++) {
        const isBot = i >= game.humanCount;
        game.players.push(new Player(i, slice * i, isBot));
    }

    let safeAngle = 0;
    let attempts = 0;
    let isSafe = false;

    while (!isSafe && attempts < 50) {
        safeAngle = Math.random() * Math.PI * 2;
        isSafe = true;
        for (let p of game.players) {
            let diff = Math.abs((safeAngle - p.angle + Math.PI * 3) % (Math.PI * 2) - Math.PI);
            if (diff < 0.5) { isSafe = false; break; }
        }
        attempts++;
    }

    game.ball = {
        angle: safeAngle,
        speed: Math.random() > 0.5 ? START_SPEED : -START_SPEED,
        color: '#fff',
        trail: []
    };

    loop();
}

function endGame(winner) {
    game.phase = STATE.GAMEOVER;
    AudioEngine.sfxWin();

    const text = document.getElementById('winner-text');
    if (winner) {
        text.innerHTML = winner.isBot
            ? `<span style="color:#cbd5e1">BOT ${winner.id + 1} WINS</span>`
            : `<span style="color:${winner.color}">PLAYER ${winner.id + 1} WINS</span>`;
    } else {
        text.innerText = "DRAW";
        text.style.color = "#fff";
    }

    setTimeout(() => {
        uiGameOver.classList.remove('hidden');
        game.phase = STATE.MENU;
    }, 1000);
}

function showMenu() {
    uiGameOver.classList.add('hidden');
    uiMenu.classList.remove('hidden');
    ctx.clearRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);
}

updateUIDisplay();
/* --- JS END --- */