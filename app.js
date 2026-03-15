// ============================================================
// HarmonyGen - app.js
// Implementerar: PitchShift, skala-igenkänning, visualisering,
//                filhantering, latensoptimering, gränssnittskontroller
// ============================================================

// === Konstanter ===
const NOTES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

// Krumhansl-Kessler key profiles för dur/moll-igenkänning
const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

// Intervall i halvtoner per läge (dur/moll)
const INTERVALS = {
    third:  { major: 4,  minor: 3  },
    fifth:  { major: 7,  minor: 7  },
    sixth:  { major: 9,  minor: 8  },
    octave: { major: 12, minor: 12 },
};

// === Ljudstatus ===
let mic = null;
let waveformAnalyser = null;
let harmonyVoices = [];
let pitchDetector = null;
let animationId = null;
let isRunning = false;

// Inspelning/export
let recorder = null;
let isRecording = false;

// Skala-igenkänning: ackumulerad chromagram
const chromagram = new Array(12).fill(0);
let totalDetected = 0;
let currentScale = { key: 0, mode: 'major' };

// === UI-element ===
const startBtn        = document.getElementById('start-btn');
const pitchDisplay    = document.getElementById('pitch-display');
const noteDisplay     = document.getElementById('note-display');
const statusText      = document.getElementById('status');
const harmonyTypeSelect = document.getElementById('harmony-type');
const voiceCountSelect  = document.getElementById('voice-count');
const scaleDisplay    = document.getElementById('scale-display');
const waveformCanvas  = document.getElementById('waveform-canvas');
const fileInput       = document.getElementById('file-input');
const exportBtn       = document.getElementById('export-btn');
const downloadLink    = document.getElementById('download-link');
const settingsToggle  = document.getElementById('settings-toggle');
const settingsPanel   = document.getElementById('settings-popup');

// ============================================================
// Skala-igenkänning (dur/moll)
// ============================================================

function pearsonCorrelation(a, b) {
    const n = a.length;
    const meanA = a.reduce((s, v) => s + v, 0) / n;
    const meanB = b.reduce((s, v) => s + v, 0) / n;
    let num = 0, denA = 0, denB = 0;
    for (let i = 0; i < n; i++) {
        const da = a[i] - meanA, db = b[i] - meanB;
        num += da * db;
        denA += da * da;
        denB += db * db;
    }
    return num / (Math.sqrt(denA * denB) + 1e-9);
}

function detectScale(chroma) {
    const total = chroma.reduce((s, v) => s + v, 0) || 1;
    const normalized = chroma.map(v => v / total);
    let bestScore = -Infinity, bestKey = 0, bestMode = 'major';

    for (let key = 0; key < 12; key++) {
        const rotated = [...normalized.slice(key), ...normalized.slice(0, key)];
        const majorScore = pearsonCorrelation(rotated, MAJOR_PROFILE);
        const minorScore = pearsonCorrelation(rotated, MINOR_PROFILE);
        if (majorScore > bestScore) { bestScore = majorScore; bestKey = key; bestMode = 'major'; }
        if (minorScore > bestScore) { bestScore = minorScore; bestKey = key; bestMode = 'minor'; }
    }
    return { key: bestKey, mode: bestMode };
}

// ============================================================
// Harmonigenerator med Tone.PitchShift
// ============================================================

function getSemitoneShifts() {
    const interval = harmonyTypeSelect ? harmonyTypeSelect.value : 'third';
    const mode = currentScale.mode;
    const count = parseInt(voiceCountSelect ? voiceCountSelect.value : '1', 10);
    const base = INTERVALS[interval] ? INTERVALS[interval][mode] : 4;
    return Array.from({ length: count }, (_, i) => base * (i + 1));
}

async function setupHarmonyVoices() {
    if (!mic) return;

    // Koppla bort och rensa gamla stämmor
    harmonyVoices.forEach(v => {
        try { mic.disconnect(v); } catch (_) {}
        v.dispose();
    });
    harmonyVoices = [];

    const shifts = getSemitoneShifts();
    for (const shift of shifts) {
        const ps = new Tone.PitchShift({
            pitch: shift,
            windowSize: 0.03, // 30 ms fönster – lägre latens
            delayTime: 0,
            feedback: 0,
        });
        mic.connect(ps);
        ps.toDestination();
        harmonyVoices.push(ps);
    }
}

function updateHarmonyPitches() {
    const shifts = getSemitoneShifts();
    if (shifts.length !== harmonyVoices.length) {
        setupHarmonyVoices();
        return;
    }
    harmonyVoices.forEach((v, i) => { v.pitch = shifts[i]; });
}

// ============================================================
// Tonhöjdshjälpmedel
// ============================================================

function getNoteName(frequency) {
    const halfSteps = Math.round(12 * Math.log2(frequency / 440));
    const noteIndex = ((halfSteps + 69) % 12 + 12) % 12;
    const octave = Math.floor((halfSteps + 69) / 12);
    return `${NOTES[noteIndex]}${octave}`;
}

function getNoteIndex(frequency) {
    const halfSteps = Math.round(12 * Math.log2(frequency / 440));
    return ((halfSteps + 69) % 12 + 12) % 12;
}

// ============================================================
// Visualisering (vågform på canvas)
// ============================================================

function resizeCanvas() {
    if (!waveformCanvas) return;
    waveformCanvas.width  = waveformCanvas.offsetWidth;
    waveformCanvas.height = waveformCanvas.offsetHeight;
}

function drawWaveform(data) {
    if (!waveformCanvas) return;
    const ctx = waveformCanvas.getContext('2d');
    const { width, height } = waveformCanvas;

    ctx.fillStyle = '#0f172a';
    ctx.fillRect(0, 0, width, height);

    // Mittlinje
    ctx.strokeStyle = '#334155';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, height / 2);
    ctx.lineTo(width, height / 2);
    ctx.stroke();

    // Vågform
    ctx.strokeStyle = '#22d3ee';
    ctx.lineWidth = 2;
    ctx.beginPath();
    const step = Math.max(1, Math.floor(data.length / width));
    for (let x = 0; x < width; x++) {
        const sample = data[x * step] !== undefined ? data[x * step] : 0;
        const y = ((sample + 1) / 2) * height;
        x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.stroke();
}

// ============================================================
// Huvud-ljudloop
// ============================================================

function audioLoop() {
    if (!isRunning) return;

    const data = waveformAnalyser.getValue();
    const sampleRate = Tone.getContext().rawContext.sampleRate;
    const [pitch, clarity] = pitchDetector.findPitch(data, sampleRate);

    if (clarity > 0.8 && pitch > 60 && pitch < 1800) {
        pitchDisplay.innerText = `${Math.round(pitch)} Hz`;
        noteDisplay.innerText  = `Not: ${getNoteName(pitch)}`;

        // Uppdatera chromagram för skala-igenkänning
        chromagram[getNoteIndex(pitch)] += 1;
        totalDetected++;

        // Periodisk skala-detektering och harmoniuppdatering
        if (totalDetected % 30 === 0) {
            // Avklingning för att anpassa sig till tonartsskiften
            for (let i = 0; i < 12; i++) chromagram[i] *= 0.92;

            const detected = detectScale(chromagram);
            if (detected.key !== currentScale.key || detected.mode !== currentScale.mode) {
                currentScale = detected;
                if (scaleDisplay) {
                    scaleDisplay.innerText =
                        `Tonart: ${NOTES[currentScale.key]} ${currentScale.mode === 'major' ? 'dur' : 'moll'}`;
                }
                updateHarmonyPitches();
            }
        }
    } else {
        pitchDisplay.innerText = '-- Hz';
        noteDisplay.innerText  = 'Not: --';
    }

    drawWaveform(data);
    animationId = requestAnimationFrame(audioLoop);
}

// ============================================================
// Initiera mikrofonljud (latensoptimerat)
// ============================================================

async function initAudio() {
    await Tone.start();

    // Latensoptimering: stäng av lookahead och korta uppdateringsintervall
    Tone.getContext().lookAhead     = 0;
    Tone.getContext().updateInterval = 0.01;

    mic = new Tone.UserMedia();
    waveformAnalyser = new Tone.Analyser('waveform', 2048);

    try {
        await mic.open();
        mic.connect(waveformAnalyser);

        pitchDetector = pitchy.PitchDetector.forFloat32Array(waveformAnalyser.size);
        await setupHarmonyVoices();

        statusText.innerText = 'Lyssnar...';
        isRunning = true;
        audioLoop();
        startBtn.textContent = 'Stopp';
    } catch (err) {
        statusText.innerText = 'Mikrofon nekad.';
        console.error(err);
    }
}

function stopAudio() {
    isRunning = false;
    cancelAnimationFrame(animationId);

    harmonyVoices.forEach(v => { try { v.dispose(); } catch (_) {} });
    harmonyVoices = [];

    if (mic)              { try { mic.close(); mic.dispose(); } catch (_) {} mic = null; }
    if (waveformAnalyser) { try { waveformAnalyser.dispose(); } catch (_) {} waveformAnalyser = null; }

    statusText.innerText = 'Stoppad.';
    startBtn.textContent = 'Starta Mikrofon';
}

// ============================================================
// Filhantering: ladda upp och spela upp ljudfil
// ============================================================

async function handleFileUpload(event) {
    const file = event.target.files[0];
    if (!file) return;

    await Tone.start();
    Tone.getContext().lookAhead = 0;

    if (isRunning) stopAudio();

    statusText.innerText = `Laddar: ${file.name}...`;

    try {
        // Använd FileReader för bred mobilkompatibilitet
        const arrayBuffer = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = e => resolve(e.target.result);
            reader.onerror = () => reject(new Error('FileReader misslyckades'));
            reader.readAsArrayBuffer(file);
        });

        const rawCtx = Tone.getContext().rawContext;
        if (!rawCtx) throw new Error('AudioContext ej tillgänglig');

        const audioBuffer = await rawCtx.decodeAudioData(arrayBuffer.slice(0));

        // Sätt upp analyser för visualisering
        if (!waveformAnalyser) waveformAnalyser = new Tone.Analyser('waveform', 2048);
        if (!pitchDetector)    pitchDetector = pitchy.PitchDetector.forFloat32Array(waveformAnalyser.size);

        const toneBuffer = new Tone.ToneAudioBuffer(audioBuffer);
        const player = new Tone.Player(toneBuffer);
        player.connect(waveformAnalyser);
        player.toDestination();

        // Harmoni-PitchShift för filen
        const shifts = getSemitoneShifts();
        const filePitchShifters = [];
        shifts.forEach(shift => {
            const ps = new Tone.PitchShift({ pitch: shift, windowSize: 0.03 });
            player.connect(ps);
            ps.toDestination();
            filePitchShifters.push(ps);
        });

        player.start();
        isRunning = true;
        audioLoop();

        // Rensa upp efter uppspelning
        setTimeout(() => {
            isRunning = false;
            filePitchShifters.forEach(ps => { try { ps.dispose(); } catch (_) {} });
            try { player.dispose(); } catch (_) {}
            statusText.innerText = 'Uppspelning klar.';
        }, audioBuffer.duration * 1000 + 500);

        statusText.innerText = `Spelar: ${file.name}`;
    } catch (err) {
        statusText.innerText = `Fel: ${err.message || 'Kunde inte läsa filen'}`;
        console.error('handleFileUpload fel:', err);
    }
}

// ============================================================
// Inspelning och export (WebM-audio)
// ============================================================

async function toggleRecording() {
    try {
        if (isRecording) {
            const blob = await recorder.stop();
            recorder = null;
            isRecording = false;
            exportBtn.textContent = '⏺ Spela in';

            const ext  = blob.type.includes('mp4') ? 'mp4' : 'webm';
            const url  = URL.createObjectURL(blob);
            if (downloadLink) {
                downloadLink.href     = url;
                downloadLink.download = `harmony-export.${ext}`;
                downloadLink.style.display = 'inline-block';
                downloadLink.addEventListener('click', () => {
                    setTimeout(() => URL.revokeObjectURL(url), 10000);
                }, { once: true });
            }
        } else {
            await Tone.start();
            if (downloadLink) { downloadLink.style.display = 'none'; downloadLink.href = '#'; }
            recorder = new Tone.Recorder();
            Tone.getDestination().connect(recorder);
            await recorder.start();
            isRecording = true;
            exportBtn.textContent = '⏹ Stoppa inspelning';
            statusText.innerText = 'Spelar in...';
        }
    } catch (err) {
        statusText.innerText = `Inspelningsfel: ${err.message || err}`;
        console.error('toggleRecording fel:', err);
        isRecording = false;
        recorder = null;
        exportBtn.textContent = '⏺ Spela in';
    }
}

// ============================================================
// Gränssnittshändelser
// ============================================================

startBtn.addEventListener('click', () => {
    if (isRunning) {
        stopAudio();
    } else {
        startBtn.disabled = true;
        initAudio().finally(() => { startBtn.disabled = false; });
    }
});

settingsToggle && settingsToggle.addEventListener('click', () => {
    settingsPanel && settingsPanel.classList.toggle('visible');
});

harmonyTypeSelect && harmonyTypeSelect.addEventListener('change', () => {
    if (isRunning) updateHarmonyPitches();
});

voiceCountSelect && voiceCountSelect.addEventListener('change', () => {
    if (isRunning) setupHarmonyVoices();
});

fileInput  && fileInput.addEventListener('change', handleFileUpload);
exportBtn  && exportBtn.addEventListener('click', toggleRecording);

window.addEventListener('resize', resizeCanvas);
resizeCanvas();
