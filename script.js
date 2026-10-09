(function() {
    'use strict';

    // ==================== CONFIGURAÇÕES E ESTADO ====================
    const canvas = document.getElementById('waveCanvas');
    // [6.3] fallback se getContext('2d') falhar
    const ctx = canvas.getContext('2d');
    if (!ctx) {
        document.body.innerHTML =
            '<p style="color:#ff5555;font-family:monospace;padding:20px">' +
            'Seu navegador não suporta Canvas 2D.</p>';
        return;
    }

    const startBtn         = document.getElementById('startBtn');
    const stopBtn          = document.getElementById('stopBtn');
    const clearBtn         = document.getElementById('clearBtn');
    const zoomInBtn        = document.getElementById('zoomInBtn');
    const zoomOutBtn       = document.getElementById('zoomOutBtn');
    const zoomResetBtn     = document.getElementById('zoomResetBtn');
    const zoomLevel        = document.getElementById('zoomLevel');
    const statusMsg        = document.getElementById('statusMsg');

    const freqValue        = document.getElementById('freqValue');
    const amplitudeValue   = document.getElementById('amplitudeValue');
    const periodValue      = document.getElementById('periodValue');
    const showFunctionBtn  = document.getElementById('showFunctionBtn');
    const funcValue        = document.getElementById('funcValue');
    const toggleWaveBtn    = document.getElementById('toggleWaveBtn');
    const functionOverlay  = document.getElementById('functionOverlay');

    // Web Audio API
    let audioContext   = null;
    let analyserVis    = null;   // [2.1] visual (smoothing 0.85)
    let analyserRaw    = null;   // [2.1] medição (smoothing 0)
    let microphoneStream = null;
    let microphoneSource = null;
    let isRunning   = false;
    let isStarting  = false;
    let captureRequestId = 0;
    let animationId = null;

    // Dados do frame congelado
    let frozenTimeData = null;
    let frozenFreqData = null;
    let frozenSampleRate = 0;

    // [2.2] 8192 → ~186 ms @44.1kHz, bom para voz/instrumento.
    // Para tons longos pode-se subir para 16384.
    const FFT_SIZE = 8192;

    // Zoom
    let zoomFactor = 1.0;
    const ZOOM_MIN  = 1.0;
    const ZOOM_MAX  = 20.0;
    const ZOOM_STEP = 1.25;
    let panOffset = 0;

    // [5.1][5.2] buffers pré-alocados
    let timeBuffer = null;
    let freqBuffer = null;

    // [5.3] cache da grade
    const gridCache = document.createElement('canvas');
    let lastGridKey = '';

    // [1.4] throttle de redesenho
    let redrawScheduled = false;
    let waveVisible = true;

    // ==================== CANVAS / DPR ====================
    // [4.6][7.1] ajusta o canvas ao tamanho real * devicePixelRatio
    function resizeCanvasToDisplaySize() {
        const dpr = window.devicePixelRatio || 1;
        const rect = canvas.getBoundingClientRect();
        const w = Math.max(1, Math.round(rect.width  * dpr));
        const h = Math.max(1, Math.round(rect.height * dpr));
        if (canvas.width !== w || canvas.height !== h) {
            canvas.width  = w;
            canvas.height = h;
            lastGridKey = '';  // força regenerar grade
            redrawCurrent();
        }
    }

    function getCanvasSize() {
        return { w: canvas.width, h: canvas.height };
    }

    // ==================== GRADE CACHEADO [5.3] ====================
    function renderGrid() {
        const w = canvas.width, h = canvas.height;
        gridCache.width  = w;
        gridCache.height = h;
        const g = gridCache.getContext('2d');
        g.fillStyle = '#000';
        g.fillRect(0, 0, w, h);

        g.strokeStyle = '#00ffcc20';
        g.lineWidth = 1;

        for (let i = 0; i <= 4; i++) {
            const y = (h / 4) * i;
            g.beginPath();
            g.moveTo(0, y);
            g.lineTo(w, y);
            g.stroke();
        }
        const numV = Math.max(8, Math.round(8 * zoomFactor));
        for (let i = 0; i <= numV; i++) {
            const x = (w / numV) * i;
            g.beginPath();
            g.moveTo(x, 0);
            g.lineTo(x, h);
            g.stroke();
        }
    }

    function clearCanvas() {
        const key = `${canvas.width}x${canvas.height}@${zoomFactor.toFixed(3)}`;
        if (key !== lastGridKey) {
            lastGridKey = key;
            renderGrid();
        }
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(gridCache, 0, 0);
    }

    // ==================== DESENHO ====================
    // [1.1] quadraticCurveTo usando ponto atual como controle e médio como destino
    // [5.4] desliga glow em zoom alto
    function applyDisplayBiquad(input, cutoffHz, type, sampleRate) {
        const omega = 2 * Math.PI * cutoffHz / sampleRate;
        const cos = Math.cos(omega);
        const alpha = Math.sin(omega) / (2 * Math.SQRT1_2);
        const a0 = 1 + alpha;
        const b0 = type === 'highpass' ? (1 + cos) / (2 * a0) : (1 - cos) / (2 * a0);
        const b1 = type === 'highpass' ? -(1 + cos) / a0 : (1 - cos) / a0;
        const b2 = b0;
        const a1 = -2 * cos / a0;
        const a2 = (1 - alpha) / a0;
        const output = new Float32Array(input.length);
        let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
        for (let i = 0; i < input.length; i++) {
            const x0 = input[i];
            const y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
            output[i] = y0;
            x2 = x1; x1 = x0; y2 = y1; y1 = y0;
        }
        return output;
    }

    function drawWaveformWindowed(dataArray, color = '#00ffcc', lineWidth = 2.5, glow = true) {
        if (!dataArray || dataArray.length === 0) return;
        const { w, h } = getCanvasSize();
        const N = dataArray.length;

        const sampleRate = frozenSampleRate || audioContext?.sampleRate || 44100;
        // Filtros apenas visuais: corta graves abaixo de 150 Hz e suaviza acima de 650 Hz.
        const normalizedData = Float32Array.from(dataArray, value => (value - 128) / 128);
        const withoutBass = applyDisplayBiquad(normalizedData, 150, 'highpass', sampleRate);
        const smoothData = applyDisplayBiquad(withoutBass, 650, 'lowpass', sampleRate);
        const displayData = Float32Array.from(smoothData, value => 128 + value * 128);

        // Janela de 20 ms: poucas oscilações grandes e arredondadas, como na referência.
        const windowSamples = Math.min(N, Math.max(2, Math.round(sampleRate * 0.02)));
        const visibleCount = Math.max(2, Math.floor(windowSamples / zoomFactor));
        const maxStart = N - visibleCount;
        const start = Math.max(0, Math.min(maxStart, Math.floor(panOffset * maxStart)));
        const end = Math.min(N, start + visibleCount);
        const visibleSpan = end - start;
        const step = w / visibleSpan;

        // Ganho automático apenas para o desenho: mantém a curva grande mesmo com sinal fraco.
        // O limiar evita ampliar ruído quando não há som; frequência/amplitude medidas não mudam.
        let visiblePeak = 0;
        for (let i = start; i < end; i++) {
            visiblePeak = Math.max(visiblePeak, Math.abs((displayData[i] - 128) / 128));
        }
        const visualGain = visiblePeak > 0.005 ? 0.32 / visiblePeak : 1;
        const yOf = i => h / 2 - ((displayData[i] - 128) / 128) * visualGain * h;

        ctx.save();
        if (glow && zoomFactor < 8) {
            ctx.shadowColor = '#00ffcc';
            ctx.shadowBlur = 15;
        }
        ctx.strokeStyle = color;
        ctx.lineWidth = lineWidth;
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(0, yOf(start));
        for (let i = start + 1; i < end; i++) {
            const xPrev = (i - start - 1) * step;
            const yPrev = yOf(i - 1);
            const xCur  = (i - start) * step;
            const yCur  = yOf(i);
            // ponto médio como destino, ponto ATUAL como controle
            ctx.quadraticCurveTo(xCur, yCur, (xPrev + xCur) / 2, (yPrev + yCur) / 2);
        }
        ctx.lineTo((end - 1 - start) * step, yOf(end - 1));
        ctx.stroke();
        ctx.restore();
    }

    // [1.2] overlay de espectro (usa frozenFreqData)
    function drawSpectrumOverlay(freqData, w, h) {
        if (!freqData || freqData.length === 0) return;
        const bins = freqData.length;
        const barW = w / bins;
        ctx.save();
        ctx.globalAlpha = 0.25;
        ctx.fillStyle = '#00ffcc';
        for (let i = 0; i < bins; i++) {
            const barH = (freqData[i] / 255) * h * 0.6;
            ctx.fillRect(i * barW, h - barH, Math.max(barW, 0.5), barH);
        }
        ctx.restore();
    }

    // ==================== ANÁLISE MATEMÁTICA ====================
    // [2.3] filtro passa-baixa IIR one-pole antes do zero-crossing
    function lowpass(samples, cutoffFrac) {
        const a = Math.exp(-2 * Math.PI * cutoffFrac);
        const out = new Float32Array(samples.length);
        let y = 0;
        for (let i = 0; i < samples.length; i++) {
            y = (1 - a) * samples[i] + a * y;
            out[i] = y;
        }
        return out;
    }

    function analyzeFrozenFrame(timeData, freqData, sampleRate) {
        // [1.6] guarda length === 0
        if (!freqData || freqData.length === 0) {
            freqValue.textContent = '— Hz';
            statusMsg.textContent = '❌ Sem dados espectrais';
            return;
        }
        if (!timeData || timeData.length === 0) {
            freqValue.textContent = '— Hz';
            statusMsg.textContent = '❌ Sem dados temporais';
            return;
        }

        // ---------- 1) Pico do espectro ----------
        let peakIndex = 0, peakValue = 0;
        for (let i = 1; i < freqData.length; i++) {
            if (freqData[i] > peakValue) {
                peakValue = freqData[i];
                peakIndex = i;
            }
        }

        // [2.4] refinamento sub-bin por parábola
        let refinedPeak = peakIndex;
        if (peakIndex > 0 && peakIndex < freqData.length - 1) {
            const yL = freqData[peakIndex - 1];
            const y0 = freqData[peakIndex];
            const yR = freqData[peakIndex + 1];
            const denom = (yL - 2 * y0 + yR);
            if (denom !== 0) {
                refinedPeak = peakIndex + 0.5 * (yL - yR) / denom;
            }
        }

        const fftSize = freqData.length * 2;
        const frequency = refinedPeak * (sampleRate / fftSize);

        // ---------- 2) Normalizar e calcular RMS [1.5] ----------
        const N = timeData.length;
        const samples = new Float32Array(N);
        let sampleMean = 0;
        for (let i = 0; i < N; i++) {
            samples[i] = (timeData[i] - 128) / 128;
            sampleMean += samples[i];
        }
        sampleMean /= N;
        for (let i = 0; i < N; i++) samples[i] -= sampleMean;

        let sumSq = 0;
        for (let i = 0; i < N; i++) sumSq += samples[i] * samples[i];
        const rms = Math.sqrt(sumSq / N);
        const RMS_MIN = 0.005; // ~ -46 dBFS

        if (rms < RMS_MIN) {
            freqValue.textContent = '— Hz';
            amplitudeValue.textContent = '—';
            periodValue.textContent = '— ms';
            funcValue.textContent = '⚠ Sinal abaixo do limiar de detecção (silêncio/ruído).';
            funcValue.hidden = true;
            showFunctionBtn.hidden = false;   // [7.5] botão visível mesmo sem sinal
            showFunctionBtn.textContent = 'Mostrar detalhes';
            statusMsg.textContent = '⏸ Sinal insuficiente';
            return;
        }

        // [4.9] detecção de clipping
        let clipped = false;
        for (let i = 0; i < N; i++) {
            if (Math.abs(samples[i]) >= 0.985) { clipped = true; break; }
        }
        if (clipped) {
            statusMsg.textContent = '⚠ Sinal saturado — reduza o volume de entrada';
        }

        // ---------- 3) Zero-crossings sobre sinal filtrado [2.3] ----------
        const filtered = lowpass(samples, 0.12);
        const zeroCrossings = [];
        for (let i = 1; i < N; i++) {
            const prev = filtered[i - 1];
            const curr = filtered[i];
            if (prev < 0 && curr >= 0) {
                const frac = -prev / (curr - prev);
                zeroCrossings.push(i - 1 + frac);
            }
        }

        let freqFromZC = frequency;
        if (frequency > 0 && zeroCrossings.length > 1) {
            const periods = [];
            for (let i = 1; i < zeroCrossings.length; i++) {
                const period = zeroCrossings[i] - zeroCrossings[i - 1];
                if (period > 2 && period < N / 2) {
                    const crossingFrequency = sampleRate / period;
                    if (Math.abs(crossingFrequency - frequency) <= Math.max(5, frequency * 0.1)) {
                        periods.push(period);
                    }
                }
            }
            if (periods.length > 0) {
                const averagePeriod = periods.reduce((s, p) => s + p, 0) / periods.length;
                freqFromZC = sampleRate / averagePeriod;
            }
        }

        // [7.2] validação de faixa plausível
        const FREQ_MIN = 20, FREQ_MAX = 20000;
        if (!(freqFromZC >= FREQ_MIN && freqFromZC <= FREQ_MAX)) {
            freqValue.textContent = '— Hz';
            amplitudeValue.textContent = '—';
            periodValue.textContent = '— ms';
            funcValue.textContent = `⚠ Frequência fora da faixa audível (${freqFromZC.toFixed(0)} Hz).`;
            funcValue.hidden = true;
            showFunctionBtn.hidden = false;
            statusMsg.textContent = '⏸ Frequência fora da faixa';
            return;
        }

        // ---------- 4) Regressão por mínimos quadrados ----------
        // Modelo: y(t) = a·sen(ω·t) + b·cos(ω·t)
        const omega = 2 * Math.PI * freqFromZC / sampleRate;

        let Sss = 0, Scc = 0, Ssc = 0, Ssy = 0, Scy = 0;
        for (let i = 0; i < N; i++) {
            const s = Math.sin(omega * i);
            const c = Math.cos(omega * i);
            const y = samples[i];
            Sss += s * s;
            Scc += c * c;
            Ssc += s * c;
            Ssy += s * y;
            Scy += c * y;
        }

        const det = Sss * Scc - Ssc * Ssc;
        let a = 0, b = 0;
        if (Math.abs(det) > 1e-10) {
            a = (Ssy * Scc - Scy * Ssc) / det;
            b = (Scy * Sss - Ssy * Ssc) / det;
        }
        const A_fit = Math.sqrt(a * a + b * b);

        // Exibe dBFS relativo ao fundo de escala, preservando A_fit normalizado para a função.
        const amplitudeDbfs = 20 * Math.log10(Math.max(Math.min(A_fit, 1), 1e-5));
        freqValue.textContent = `${freqFromZC.toFixed(1)} Hz`;
        amplitudeValue.textContent = `${amplitudeDbfs.toFixed(1)} dBFS`;
        periodValue.textContent = `${(1000 / freqFromZC).toFixed(2)} ms`;

        // [4.3] toggle: mantém botão visível para alternar
        funcValue.textContent =
            `f(x) = ${A_fit.toFixed(3)} · sen(2π · ${freqFromZC.toFixed(1)} · x), `;
        funcValue.title =
            'A é a amplitude de pico normalizada (0..1) relativa ao fundo de escala digital; ' +
            'x é o tempo em segundos.';
        funcValue.hidden = true;
        functionOverlay.hidden = true;
        showFunctionBtn.hidden = false;
        showFunctionBtn.textContent = 'Mostrar função';

        if (!clipped) {
            statusMsg.textContent = `⏸ ${freqFromZC.toFixed(1)} Hz`;
        }

        // [7.4] log de diagnóstico
        logDiag('analyze', { rms, freqFromZC, A_fit, clipped });
    }

    function clearAnalysisResults() {
        freqValue.textContent = '— Hz';
        amplitudeValue.textContent = '—';
        periodValue.textContent = '— ms';
        funcValue.textContent = '—';
        funcValue.removeAttribute('title');
        funcValue.hidden = true;
        functionOverlay.hidden = true;
        showFunctionBtn.hidden = true;
        showFunctionBtn.textContent = 'Mostrar função';
    }

    // ==================== LOOP ====================
    function ensureBuffers() {
        if (!analyserVis) return false;
        if (!timeBuffer || timeBuffer.length !== analyserVis.fftSize) {
            timeBuffer = new Uint8Array(analyserVis.fftSize);
        }
        if (!freqBuffer || freqBuffer.length !== analyserVis.frequencyBinCount) {
            freqBuffer = new Uint8Array(analyserVis.frequencyBinCount);
        }
        return true;
    }

    function drawFrame() {
        if (!analyserVis || !isRunning) return;
        if (!ensureBuffers()) return;

        analyserVis.getByteTimeDomainData(timeBuffer);
        clearCanvas();
        if (waveVisible) drawWaveformWindowed(timeBuffer, '#00ffcc', 2.5, true);

        animationId = requestAnimationFrame(drawFrame);
    }

    function redrawFrozen() {
        clearCanvas();
        if (waveVisible) {
            if (frozenFreqData) drawSpectrumOverlay(frozenFreqData, canvas.width, canvas.height);
            if (frozenTimeData) drawWaveformWindowed(frozenTimeData, '#00ffcc', 2.5, true);
        }
    }

    // [3.3] unifica o caminho de desenho
    function redrawCurrent() {
        if (isRunning) drawFrameOnce();
        else redrawFrozen();
    }

    // [1.4] throttle via rAF
    function scheduleRedraw() {
        if (redrawScheduled) return;
        redrawScheduled = true;
        requestAnimationFrame(() => {
            redrawScheduled = false;
            redrawCurrent();
        });
    }

    function drawFrameOnce() {
        if (!analyserVis || !ensureBuffers()) return;
        analyserVis.getByteTimeDomainData(timeBuffer);
        clearCanvas();
        if (waveVisible) drawWaveformWindowed(timeBuffer, '#00ffcc', 2.5, true);
    }

    // ==================== ÁUDIO ====================
    // [6.4] resume com retry
    async function ensureAudioReady() {
        if (!audioContext || audioContext.state === 'closed') {
            audioContext = new (window.AudioContext || window.webkitAudioContext)();
        }
        if (audioContext.state === 'suspended') {
            await audioContext.resume();
        }
        if (audioContext.state !== 'running') {
            throw new Error('Contexto de áudio bloqueado — clique novamente');
        }
    }

    async function startCapture() {
        if (isRunning || isStarting) return;
        const requestId = ++captureRequestId;
        isStarting = true;
        startBtn.disabled = true;
        try {
            statusMsg.textContent = '🎙 Solicitando acesso ao microfone...';

            // [6.1] mensagem específica para file://
            if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
                const isFile = location.protocol === 'file:';
                throw new Error(isFile
                    ? 'Abra a página via https:// ou http://localhost — o navegador bloqueia microfone em file://'
                    : 'getUserMedia não disponível neste navegador');
            }

            microphoneStream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    echoCancellation: false,
                    noiseSuppression: false,
                    autoGainControl: false
                }
            });

            // [3.1] clearAll() durante o prompt — libera o stream que acabou de chegar
            if (requestId !== captureRequestId) {
                releaseMicrophone();
                if (audioContext && audioContext.state !== 'closed') {
                    try { await audioContext.close(); } catch (_) {}
                }
                audioContext = null;
                return;
            }

            await ensureAudioReady();
            if (requestId !== captureRequestId) {
                releaseMicrophone();
                return;
            }

            microphoneSource = audioContext.createMediaStreamSource(microphoneStream);

            // [2.1] dois analysers: um para visual, outro cru para medição
            analyserVis = audioContext.createAnalyser();
            analyserVis.fftSize = FFT_SIZE;
            analyserVis.smoothingTimeConstant = 0.85;

            analyserRaw = audioContext.createAnalyser();
            analyserRaw.fftSize = FFT_SIZE;
            analyserRaw.smoothingTimeConstant = 0.0;

            microphoneSource.connect(analyserVis);
            microphoneSource.connect(analyserRaw);

            frozenTimeData = null;
            frozenFreqData = null;
            frozenSampleRate = 0;
            clearAnalysisResults();

            isRunning = true;
            stopBtn.disabled = false;
            statusMsg.textContent = '🎙 Capturando microfone...';
            statusMsg.style.color = '';

            if (animationId) cancelAnimationFrame(animationId);
            drawFrame();

            logDiag('startCapture', { sampleRate: audioContext.sampleRate });

        } catch (err) {
            if (requestId !== captureRequestId) return;
            // [7.4] log de erro
            console.error('[WAVE] startCapture error:', err);
            releaseMicrophone();
            analyserVis = analyserRaw = null;

            // [7.3] mapeamento completo de erros
            const errorMap = {
                NotAllowedError:      '❌ Permissão do microfone negada',
                PermissionDeniedError:'❌ Permissão do microfone negada',
                NotFoundError:        '❌ Nenhum microfone encontrado',
                DevicesNotFoundError: '❌ Nenhum microfone encontrado',
                NotReadableError:     '❌ Microfone em uso por outro aplicativo',
                TrackStartError:      '❌ Microfone em uso por outro aplicativo',
                OverconstrainedError: '❌ Restrições de áudio não suportadas',
                SecurityError:        '❌ Bloqueado por política de segurança (HTTPS obrigatório)',
                AbortError:           '❌ Captura abortada — tente novamente'
            };
            statusMsg.textContent = errorMap[err.name] || `❌ ${err.message || 'Erro ao acessar o microfone'}`;
            stopBtn.disabled = true;
            isRunning = false;
        } finally {
            isStarting = false;
            startBtn.disabled = isRunning;
        }
    }

    function releaseMicrophone() {
        if (microphoneSource) {
            try { microphoneSource.disconnect(); } catch (_) {}
            microphoneSource = null;
        }
        if (microphoneStream) {
            microphoneStream.getTracks().forEach(t => t.stop());
            microphoneStream = null;
        }
    }

    // [2.6] fecha o AudioContext quando fica ocioso
    async function closeAudioContextIfIdle() {
        if (audioContext && audioContext.state !== 'closed') {
            try { await audioContext.close(); } catch (_) {}
        }
        audioContext = null;
        analyserVis = analyserRaw = null;
    }

    async function stopAndAnalyze() {
        if (!isRunning || !analyserRaw) return;

        isRunning = false;
        if (animationId) {
            cancelAnimationFrame(animationId);
            animationId = null;
        }

        // [3.2] exige sampleRate conhecido — sem fallback mentiroso
        if (!audioContext || audioContext.state === 'closed') {
            statusMsg.textContent = '❌ Contexto de áudio indisponível — reinicie a captura';
            stopBtn.disabled = true;
            startBtn.disabled = false;
            return;
        }
        const sampleRate = audioContext.sampleRate;

        // [2.1] puxa do analyser cru (smoothing = 0)
        const timeData = new Uint8Array(analyserRaw.fftSize);
        const freqData = new Uint8Array(analyserRaw.frequencyBinCount);
        analyserRaw.getByteTimeDomainData(timeData);
        analyserRaw.getByteFrequencyData(freqData);

        frozenTimeData = timeData;
        frozenFreqData = freqData;
        frozenSampleRate = sampleRate;

        releaseMicrophone();

        // [4.4] feedback visual antes do cálculo
        statusMsg.textContent = '⏳ Analisando...';
        statusMsg.style.color = '';
        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

        // [3.4] NÃO resetar zoom/pan — preserva enquadramento
        updateZoomLabel();

        analyzeFrozenFrame(frozenTimeData, frozenFreqData, sampleRate);
        redrawFrozen();

        startBtn.disabled = false;
        stopBtn.disabled = true;
    }

    function clearAll() {
        captureRequestId++;
        if (isRunning) {
            isRunning = false;
            if (animationId) {
                cancelAnimationFrame(animationId);
                animationId = null;
            }
            releaseMicrophone();
        }

        frozenTimeData = null;
        frozenFreqData = null;
        frozenSampleRate = 0;
        zoomFactor = 1.0;
        panOffset = 0;
        updateZoomLabel();

        clearCanvas();
        clearAnalysisResults();

        startBtn.disabled = false;
        stopBtn.disabled = true;
        statusMsg.textContent = '🔇 Pronto';
        statusMsg.style.color = '';

        // [2.6] libera o contexto de áudio
        closeAudioContextIfIdle();
    }

    // ==================== ZOOM ====================
    // [4.10] mostra faixa visível em ms
    function updateZoomLabel() {
        const sr = frozenSampleRate || audioContext?.sampleRate || 44100;
        const signalMs = frozenTimeData
            ? (frozenTimeData.length / sr) * 1000
            : (FFT_SIZE / sr) * 1000;
        const totalMs = Math.min(signalMs, 20);
        const visibleMs = Math.round(totalMs / zoomFactor);
        zoomLevel.textContent = `${zoomFactor.toFixed(1)}× (${visibleMs} ms)`;

        zoomInBtn.disabled  = zoomFactor >= ZOOM_MAX;
        zoomOutBtn.disabled = zoomFactor <= ZOOM_MIN;

        // [4.1][4.2] classe para cursor grab/grabbing
        canvas.classList.toggle('zoomable', zoomFactor > 1.0);
    }

    // [1.3] zoom no cursor, não no centro
    function applyZoom(newZoom, mouseXFrac = 0.5) {
        newZoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, newZoom));
        if (newZoom === zoomFactor) return;

        const oldWidth = 1 / zoomFactor;
        const newWidth = 1 / newZoom;
        const anchor = panOffset + mouseXFrac * oldWidth;
        panOffset = Math.max(0, Math.min(1 - newWidth, anchor - mouseXFrac * newWidth));
        zoomFactor = newZoom;

        updateZoomLabel();
        scheduleRedraw();
    }

    // ==================== EVENTOS ====================
    startBtn.addEventListener('click', startCapture);
    stopBtn.addEventListener('click', stopAndAnalyze);
    clearBtn.addEventListener('click', clearAll);

    // [4.3] toggle mostrar/ocultar
    showFunctionBtn.addEventListener('click', () => {
        const showing = !funcValue.hidden;
        funcValue.hidden = showing;
        functionOverlay.textContent = funcValue.textContent.trim();
        functionOverlay.hidden = showing;
        showFunctionBtn.textContent = showing ? 'Mostrar função' : 'Ocultar função';
    });
    toggleWaveBtn.addEventListener('click', () => {
        waveVisible = !waveVisible;
        toggleWaveBtn.textContent = waveVisible ? 'Ocultar onda' : 'Mostrar onda';
        toggleWaveBtn.setAttribute('aria-pressed', String(!waveVisible));
        redrawCurrent();
    });

    zoomInBtn.addEventListener('click',  () => applyZoom(zoomFactor * ZOOM_STEP, 0.5));
    zoomOutBtn.addEventListener('click', () => applyZoom(zoomFactor / ZOOM_STEP, 0.5));
    zoomResetBtn.addEventListener('click', () => {
        zoomFactor = 1.0;
        panOffset = 0;
        updateZoomLabel();
        scheduleRedraw();
    });

    // [1.3] zoom no cursor via wheel
    canvas.addEventListener('wheel', (e) => {
        e.preventDefault();
        const rect = canvas.getBoundingClientRect();
        const xFrac = (e.clientX - rect.left) / rect.width;
        applyZoom(e.deltaY < 0 ? zoomFactor * ZOOM_STEP : zoomFactor / ZOOM_STEP, xFrac);
    }, { passive: false });

    // ---------- Mouse drag [1.4] com rAF throttle ----------
    let isDragging = false;
    let dragStartX = 0;
    let dragStartPan = 0;

    canvas.addEventListener('mousedown', (e) => {
        if (zoomFactor <= 1.0) return;
        isDragging = true;
        dragStartX = e.clientX;
        dragStartPan = panOffset;
    });
    window.addEventListener('mousemove', (e) => {
        if (!isDragging) return;
        const rect = canvas.getBoundingClientRect();
        const dx = e.clientX - dragStartX;
        const visibleWidth = 1 / zoomFactor;
        const deltaFrac = -(dx / rect.width) * visibleWidth;
        panOffset = Math.max(0, Math.min(1 - visibleWidth, dragStartPan + deltaFrac));
        scheduleRedraw();   // [1.4]
    });
    window.addEventListener('mouseup', () => {
        isDragging = false;
    });

    // ---------- Touch [6.5] só bloqueia scroll quando zoom > 1 ----------
    let touchStartX = 0;
    let touchStartPan = 0;
    let isTouching = false;

    canvas.addEventListener('touchstart', (e) => {
        if (zoomFactor <= 1.0 || e.touches.length !== 1) return;
        isTouching = true;
        touchStartX = e.touches[0].clientX;
        touchStartPan = panOffset;
    }, { passive: true });

    canvas.addEventListener('touchmove', (e) => {
        if (!isTouching || zoomFactor <= 1.0 || e.touches.length !== 1) return;
        const rect = canvas.getBoundingClientRect();
        const dx = e.touches[0].clientX - touchStartX;
        const visibleWidth = 1 / zoomFactor;
        const deltaFrac = -(dx / rect.width) * visibleWidth;
        panOffset = Math.max(0, Math.min(1 - visibleWidth, touchStartPan + deltaFrac));
        scheduleRedraw();   // [1.4]
        e.preventDefault(); // só bloqueia scroll quando há zoom
    }, { passive: false });

    canvas.addEventListener('touchend', () => { isTouching = false; }, { passive: true });

    // ---------- Teclado [4.7] ----------
    canvas.addEventListener('keydown', (e) => {
        if (e.key === '+' || e.key === '=') {
            applyZoom(zoomFactor * ZOOM_STEP, 0.5);
            e.preventDefault();
        } else if (e.key === '-') {
            applyZoom(zoomFactor / ZOOM_STEP, 0.5);
            e.preventDefault();
        } else if (e.key === 'ArrowLeft' && zoomFactor > 1) {
            panOffset = Math.max(0, panOffset - 0.02 / zoomFactor);
            scheduleRedraw();
            e.preventDefault();
        } else if (e.key === 'ArrowRight' && zoomFactor > 1) {
            panOffset = Math.min(1 - 1 / zoomFactor, panOffset + 0.02 / zoomFactor);
            scheduleRedraw();
            e.preventDefault();
        } else if (e.key === '0') {
            zoomFactor = 1.0; panOffset = 0;
            updateZoomLabel(); scheduleRedraw();
            e.preventDefault();
        }
    });

    // ---------- Diagnóstico [7.4] ----------
    function logDiag(stage, extra = {}) {
        if (!window.__WAVE_DEBUG) return;
        console.debug('[WAVE]', stage, {
            sampleRate: audioContext?.sampleRate,
            fftSize: analyserVis?.fftSize,
            zoomFactor, panOffset, ...extra
        });
    }

    // ---------- ResizeObserver [4.6][7.1] ----------
    if (typeof ResizeObserver !== 'undefined') {
        const ro = new ResizeObserver(() => resizeCanvasToDisplaySize());
        ro.observe(canvas.parentElement);
    }
    window.addEventListener('resize', resizeCanvasToDisplaySize);

    // ---------- Inicialização ----------
    updateZoomLabel();
    resizeCanvasToDisplaySize();
    clearCanvas();
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
})();
