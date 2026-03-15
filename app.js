let audioContext;
let analyser;
let microphone;

const startBtn = document.getElementById('start-btn');
const pitchDisplay = document.getElementById('pitch-display');
const noteDisplay = document.getElementById('note-display');
const statusText = document.getElementById('status');

// Funktion för att översätta frekvens till notnamn
function getNoteName(frequency) {
    const notes = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
    const halfStepsFromA4 = 12 * Math.log2(frequency / 440);
    const noteIndex = (Math.round(halfStepsFromA4) + 69) % 12;
    return notes[noteIndex];
}

async function initAudio() {
    await Tone.start();
    audioContext = Tone.getContext().rawContext;
    
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const source = audioContext.createMediaStreamSource(stream);
        
        analyser = audioContext.createAnalyser();
        source.connect(analyser);
        
        statusText.innerText = "Lyssnar...";
        updatePitch();
    } catch (err) {
        statusText.innerText = "Kunde inte komma åt mikrofonen.";
        console.error(err);
    }
}

function updatePitch() {
    const data = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(data);
    
    // Använd Pitchy för att hitta tonhöjden
    const [pitch, clarity] = pitchy.PitchDetector.forFloat32Array(analyser.fftSize).findPitch(data, audioContext.sampleRate);

    if (clarity > 0.8) { // Säkerställ att ljudet är tydligt nog
        pitchDisplay.innerText = `${Math.round(pitch)} Hz`;
        noteDisplay.innerText = `Not: ${getNoteName(pitch)}`;
    }

    requestAnimationFrame(updatePitch);
}

startBtn.addEventListener('click', () => {
    initAudio();
    startBtn.disabled = true;
});
