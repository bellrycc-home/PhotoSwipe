
        // ==========================================
        // ESTADO GLOBAL DE LA APLICACIÓN
        // ==========================================
        let photos = []; // Array de objetos: { id, name, file, url, size, width, height, handle, status: 'pending' | 'keep' | 'delete', isFromDeletedFolder: boolean }
        let currentIndex = 0;
        let historyStack = [];
let redoStack = []; // Para deshacer acciones
        let directoryHandle = null; // Handle de la carpeta si se usa File System Access API
        let deletedDirHandle = null; // Handle de la subcarpeta _ELIMINADAS si existe en Modo Directo
        let isDirectMode = false;
        let currentReviewTab = 'delete';
let reviewSearchQuery = '';
        let lightboxIndex = -1;
        let isLightboxZoomed = false;
        let reviewVisibleCount = 120;
        let reviewObserver = null;
let thumbWorker = null;
let dupWorker = null;
try { dupWorker = new Worker('duplicate-worker.js'); } catch (e) { dupWorker = null; }
try { thumbWorker = new Worker('thumbnail-worker.js'); } catch (e) { thumbWorker = null; }
        const REVIEW_PAGE_SIZE = 120;
        const THUMBNAIL_MAX_EDGE = 320;
// Robustez de navegación
let isBusy = false;
let pickerOpen = false;
let renderToken = 0;
// Semáforo de decodificación
let decodeSlots = 2;
const decodeQueue = [];
function acquireDecodeSlot(){ return new Promise(resolve=>{ if(decodeSlots>0){ decodeSlots--; resolve(); } else { decodeQueue.push(resolve); } }); }
function releaseDecodeSlot(){ if(decodeQueue.length){ decodeQueue.shift()(); } else { decodeSlots++; } }

        const IMAGE_EXTENSIONS = ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'avif'];
        const VIDEO_EXTENSIONS = ['mp4', 'webm', 'mov', 'm4v', 'ogv', '3gp', 'mkv'];
        function isVideoMedia(photo) {
            const name = typeof photo === 'string' ? photo : (photo && photo.name) || '';
            return !!(photo && photo.isVideo) || VIDEO_EXTENSIONS.includes(name.split('.').pop().toLowerCase());
        }
        function mediaKind(photo) { return isVideoMedia(photo) ? 'video' : 'foto'; }

        // ==========================================
        // 1. CARGA DE ARCHIVOS (DIRECTO O COMPATIBLE)
        // ==========================================
        async function loadFolderAuto() {
            if (pickerOpen) {
                showToast('El selector ya está abierto; revisa si quedó detrás de esta ventana.');
                return;
            }
            console.log('[loadFolderAuto] showDirectoryPicker soportado:', 'showDirectoryPicker' in window);
            if ('showDirectoryPicker' in window) {
                await openDirectoryPicker();
            } else {
                console.log('[loadFolderAuto] Usando fallback a input file');
                const input = document.getElementById('fileInput');
                if (!input) {
                    console.error('[loadFolderAuto] No se encontró fileInput en el DOM');
                    showToast('❌ Error: No se encontró el selector de archivos.');
                    return;
                }
                input.click();
            }
        }

        async function openDirectoryPicker() {
            if (!('showDirectoryPicker' in window)) {
                showToast("⚠️ Tu navegador no soporta acceso directo. Usa el modo compatible.");
                return;
            }
            if (pickerOpen) {
                showToast('El selector ya está abierto; revisa si quedó detrás de esta ventana.');
                return;
            }
            pickerOpen = true;
            try {
                directoryHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
                deletedDirHandle = null;
                isDirectMode = true;
                photos = [];

                for await (const entry of directoryHandle.values()) {
                    if (entry.kind === 'file') {
                        const ext = entry.name.split('.').pop().toLowerCase();
                        if (IMAGE_EXTENSIONS.includes(ext) || VIDEO_EXTENSIONS.includes(ext)) {
                            const file = await entry.getFile();
                            photos.push({ id: crypto.randomUUID(), name: entry.name, file,
                                url: URL.createObjectURL(file), isVideo: VIDEO_EXTENSIONS.includes(ext),
                                size: file.size, width: null, height: null, handle: entry,
                                status: 'pending', isFromDeletedFolder: false, relativePath: entry.name });
                        }
                    } else if (entry.kind === 'directory' && entry.name === '_ELIMINADAS') {
                        deletedDirHandle = entry;
                    }
                }
                if (deletedDirHandle) {
                    for await (const entry of deletedDirHandle.values()) {
                        if (entry.kind !== 'file') continue;
                        const ext = entry.name.split('.').pop().toLowerCase();
                        if (IMAGE_EXTENSIONS.includes(ext) || VIDEO_EXTENSIONS.includes(ext)) {
                            const file = await entry.getFile();
                            photos.push({ id: crypto.randomUUID(), name: entry.name, file,
                                url: URL.createObjectURL(file), isVideo: VIDEO_EXTENSIONS.includes(ext),
                                size: file.size, width: null, height: null, handle: entry,
                                status: 'pending', isFromDeletedFolder: true, relativePath: '_ELIMINADAS/' + entry.name });
                        }
                    }
                }
                if (photos.length === 0) {
                    showToast("⚠️ No se encontraron fotos o vídeos compatibles en esta carpeta.");
                    return;
                }
                startSwipingSession();
            } catch (err) {
                if (err.name === 'NotAllowedError') {
                    showToast('No se pudo abrir el selector. Comprueba si ya está abierto o si quedó detrás de esta ventana.');
                } else if (err.name !== 'AbortError') {
                    console.error('Error al abrir carpeta:', err);
                    showToast('❌ No se pudo acceder a la carpeta. Intenta con el modo compatible.');
                }
            } finally {
                pickerOpen = false;
            }
        }

        function handleLegacyFiles(event) {
            console.log('[handleLegacyFiles] Evento recibido');
            const fileList = Array.from(event.target.files);
            console.log('[handleLegacyFiles] Archivos recibidos:', fileList.length);
            if (fileList.length === 0) {
                console.log('[handleLegacyFiles] No hay archivos, retornando');
                return;
            }

            isDirectMode = false;
            directoryHandle = null;
            deletedDirHandle = null;
            photos = [];

            let skipped = 0;
            fileList.forEach(file => {
                const ext = file.name.split('.').pop().toLowerCase();
                console.log('[handleLegacyFiles] Procesando:', file.name, 'ext:', ext);
                if (IMAGE_EXTENSIONS.includes(ext) || VIDEO_EXTENSIONS.includes(ext)) {
                    const relPath = file.webkitRelativePath || '';
                    const pathParts = relPath.split('/');
                    console.log('[handleLegacyFiles] webkitRelativePath:', relPath, 'pathParts:', pathParts);
                    // Verificar si está directamente dentro de _ELIMINADAS (ej: Carpeta/_ELIMINADAS/foto.jpg)
                    const isDeletedFolder = pathParts.includes('_ELIMINADAS');
                    // Ignorar otras subcarpetas que no sean _ELIMINADAS para mantener la estructura limpia
                    if (pathParts.length > 2 && !isDeletedFolder) {
                        console.log('[handleLegacyFiles] Saltando archivo en subcarpeta:', file.name);
                        skipped++;
                        return;
                    }

                    photos.push({
                        id: crypto.randomUUID(),
                        name: file.name,
                        relativePath: relPath || file.name,
                        file: file,
                        url: URL.createObjectURL(file),
                                isVideo: VIDEO_EXTENSIONS.includes(ext),
                        size: file.size,
                        width: null,
                        height: null,
                        handle: null,
                        status: 'pending',
                        isFromDeletedFolder: isDeletedFolder
                    });
                } else {
                    console.log('[handleLegacyFiles] Extensión no soportada:', ext);
                }
            });

            console.log('[handleLegacyFiles] Fotos encontradas:', photos.length, 'saltadas:', skipped);
            if (photos.length === 0) {
                showToast("⚠️ No se encontraron fotos o vídeos compatibles.");
                return;
            }

            startSwipingSession();
        }

        async function startSwipingSession() {
            // Ordenar alfabéticamente por nombre
            photos.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
            await loadStateIDB();
            const firstPendingIndex = photos.findIndex(p => p.status === 'pending');
            if (firstPendingIndex === -1) {
                // Todas las fotos ya tienen decisión: ir directo a revisión
                currentIndex = photos.length;
                historyStack = [];
                redoStack = [];

                document.getElementById('setupView').classList.add('hidden');
                document.getElementById('swipeView').classList.add('hidden');
                document.getElementById('swipeView').classList.remove('flex');
                document.getElementById('summaryView').classList.remove('hidden');
                document.getElementById('summaryView').classList.add('flex');
                document.getElementById('headerControls').classList.remove('hidden');
                document.getElementById('headerControls').classList.add('flex');

                updateHeaderStats();
                updateSummaryStats();
                switchReviewTab('delete');
                isBusy = false;
                return;
            }
            currentIndex = firstPendingIndex;
            historyStack = [];
            redoStack = [];

            document.getElementById('setupView').classList.add('hidden');
            document.getElementById('summaryView').classList.add('hidden');
            document.getElementById('swipeView').classList.remove('hidden');
            document.getElementById('swipeView').classList.add('flex');
            document.getElementById('headerControls').classList.remove('hidden');
            document.getElementById('headerControls').classList.add('flex');

            updateHeaderStats();
            isBusy = true;
            renderCurrentCard();
        }

        // ==========================================
        // 2. RENDERIZADO Y LÓGICA DE SWIPE
        // ==========================================
        async function renderCurrentCard() {
            if (currentIndex >= photos.length) { finishSwiping(); return; }
            const token = ++renderToken;
            const photo = photos[currentIndex];
            const activeCard = document.getElementById('activeCard');
            const currentImg = document.getElementById('currentCardImg');
            const currentVideo = document.getElementById('currentCardVideo');
            const nextImg = document.getElementById('nextCardImg');
            const nextVideo = document.getElementById('nextCardVideo');
            activeCard.classList.remove('card-transition', 'swipe-left', 'swipe-right');
            activeCard.style.transform = 'translateX(0px) rotate(0deg)';
            activeCard.style.opacity = '1';
            currentImg.style.transform = '';
            isDragging = false;
            currentX = currentY = 0;
            document.getElementById('badgeDelete').style.opacity = '0';
            document.getElementById('badgeKeep').style.opacity = '0';
            document.getElementById('badgePreviouslyDeleted').classList.toggle('hidden', !photo.isFromDeletedFolder);
            document.getElementById('cardTitle').textContent = photo.name;
            document.getElementById('fileNameDisplay').textContent = photo.name;

            currentImg.onload = currentImg.onerror = null;
            currentVideo.onloadedmetadata = currentVideo.onerror = null;
            currentVideo.pause();
            const url = getPhotoUrl(photo);
            let ready;
            if (isVideoMedia(photo)) {
                currentImg.classList.add('hidden');
                currentVideo.classList.remove('hidden');
                currentVideo.muted = true;
                currentVideo.loop = true;
                currentVideo.playsInline = true;
                currentVideo.src = url;
                currentVideo.load();
                ready = new Promise(resolve => {
                    if (currentVideo.readyState >= 1) resolve(true);
                    else {
                        currentVideo.onloadedmetadata = () => resolve(true);
                        currentVideo.onerror = () => resolve(false);
                    }
                });
                updateCardMetadata(photo, currentVideo);
                currentVideo.play().catch(() => {});
            } else {
                currentVideo.classList.add('hidden');
                currentVideo.removeAttribute('src');
                currentVideo.load();
                currentImg.classList.remove('hidden');
                currentImg.src = url;
                await acquireDecodeSlot();
                ready = new Promise(resolve => {
                    const done = ok => { currentImg.onload = currentImg.onerror = null; releaseDecodeSlot(); resolve(ok); };
                    if (currentImg.complete && currentImg.naturalWidth > 0) { releaseDecodeSlot(); resolve(true); return; }
                    currentImg.onload = () => done(true);
                    currentImg.onerror = () => done(false);
                });
                updateCardMetadata(photo, currentImg);
            }

            const nextPhoto = photos[currentIndex + 1];
            nextImg.classList.add('hidden');
            nextVideo.classList.add('hidden');
            nextVideo.pause();
            if (nextPhoto) {
                if (isVideoMedia(nextPhoto)) {
                    nextVideo.src = getPhotoUrl(nextPhoto);
                    nextVideo.load();
                    nextVideo.classList.remove('hidden');
                } else {
                    nextImg.src = getPhotoUrl(nextPhoto);
                    nextImg.classList.remove('hidden');
                    if (nextImg.decode) nextImg.decode().catch(() => {});
                }
            } else {
                nextImg.removeAttribute('src');
                nextVideo.removeAttribute('src');
            }

            const ok = await ready;
            if (token !== renderToken) return;
            if (!ok) showToast('⚠️ No se pudo reproducir ' + photo.name + '. El formato puede no ser compatible con este navegador.');
            const reviewedCount = photos.filter(item => item.status !== 'pending').length;
            document.getElementById('progressText').textContent = 'Archivo ' + (currentIndex + 1) + ' de ' + photos.length;
            document.getElementById('progressBar').style.width = Math.round((reviewedCount / photos.length) * 100) + '%';
            document.getElementById('btnUndo').disabled = historyStack.length === 0;
            releaseDistantUrls();
            isBusy = false;
        }

        function updateCardMetadata(photo, mediaElement) {
            const baseSize = formatBytes(photo.size);
            const apply = () => {
                const width = isVideoMedia(photo) ? mediaElement.videoWidth : mediaElement.naturalWidth;
                const height = isVideoMedia(photo) ? mediaElement.videoHeight : mediaElement.naturalHeight;
                if (width) { photo.width = width; photo.height = height; }
                if (isVideoMedia(photo) && Number.isFinite(mediaElement.duration)) photo.duration = mediaElement.duration;
                if (!width) return;
                let details = width + ' × ' + height + ' px';
                if (isVideoMedia(photo) && photo.duration) details += ' • ' + formatDuration(photo.duration);
                if (photos[currentIndex] && photos[currentIndex].id === photo.id) document.getElementById('cardMeta').textContent = baseSize + ' • ' + details;
            };
            document.getElementById('cardMeta').textContent = baseSize + (isVideoMedia(photo) ? ' • Vídeo' : '');
            if (isVideoMedia(photo)) {
                if (mediaElement.readyState >= 1) apply();
                else mediaElement.addEventListener('loadedmetadata', apply, { once: true });
            } else if (mediaElement.complete && mediaElement.naturalWidth > 0) apply();
            else mediaElement.addEventListener('load', apply, { once: true });
        }

        function formatDuration(seconds) {
            if (!Number.isFinite(seconds)) return '';
            const total = Math.floor(seconds);
            const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), sec = total % 60;
            return h ? h + ':' + String(m).padStart(2, '0') + ':' + String(sec).padStart(2, '0') : m + ':' + String(sec).padStart(2, '0');
        }

        function triggerDecision(decision) {
            if (isBusy) return; // descartar pulsaciones repetidas mientras se procesa
            if (currentIndex >= photos.length) return;

            const photo = photos[currentIndex];
            if (photo.status !== 'pending') return; // evitar clasificar dos veces

            isBusy = true;
            photo.status = decision;
            historyStack.push({ index: currentIndex, decision });
            redoStack = [];

            const activeCard = document.getElementById('activeCard');
            activeCard.classList.add('card-transition');

            if (decision === 'delete') {
                document.getElementById('badgeDelete').style.opacity = '1';
                activeCard.classList.add('swipe-left');
            } else {
                document.getElementById('badgeKeep').style.opacity = '1';
                activeCard.classList.add('swipe-right');
            }

            updateHeaderStats();

            setTimeout(() => {
                currentIndex++;
                while (currentIndex < photos.length && photos[currentIndex].status !== 'pending') {
                    currentIndex++;
                }
                renderCurrentCard();
            }, 260);
        }

        function skipCurrentPhoto() {
            if (isBusy || currentIndex >= photos.length) return;
            isBusy = true;
            const activeCard = document.getElementById('activeCard');
            activeCard.classList.add('card-transition');
            activeCard.style.transform = 'translateY(-120%)';
            activeCard.style.opacity = '0';
            setTimeout(() => {
                currentIndex++;
                while (currentIndex < photos.length && photos[currentIndex].status !== 'pending') currentIndex++;
                renderCurrentCard();
            }, 260);
        }

        function undoLastAction() {
            if (isBusy) return;
            if (historyStack.length === 0) return;
            isBusy = true;
            const action = historyStack.pop();
            photos[action.index].status = 'pending';
            redoStack.push(action);
            currentIndex = action.index;

            updateHeaderStats();
            renderCurrentCard();
            showToast("↩️ Acción deshecha");
        }

        function redoLastAction() {
            if (isBusy) return;
            if (redoStack.length === 0) return;
            isBusy = true;
            const action = redoStack.pop();
            photos[action.index].status = action.decision;
            historyStack.push(action);
            // advance
            let i = action.index + 1;
            while (i < photos.length && photos[i].status !== 'pending') i++;
            currentIndex = i >= photos.length ? photos.length : i;
            updateHeaderStats();
            renderCurrentCard();
            showToast("↪️ Acción rehecha");
        }

        function updateHeaderStats() {
            const delCount = photos.filter(p => p.status === 'delete').length;
            const keepCount = photos.filter(p => p.status === 'keep').length;

            document.getElementById('countDeleteHeader').textContent = delCount;
            document.getElementById('countKeepHeader').textContent = keepCount;
            document.getElementById('badgeTotalReviewed').textContent = delCount + keepCount;
            saveStateIDB();
        }

        // ==========================================
        // 3. GESTOS TÁCTILES, MOUSE Y TECLADO
        // ==========================================
        const activeCardEl = document.getElementById('activeCard');
        let startX = 0, startY = 0, currentX = 0, currentY = 0, isDragging = false;

        activeCardEl.addEventListener('dblclick', () => {
            if (currentIndex < photos.length) {
                openLightbox(currentIndex);
            }
        });

        activeCardEl.addEventListener('pointerdown', (e) => {
            if (currentIndex >= photos.length) return;
            isDragging = true;
            startX = e.clientX;
            startY = e.clientY;
            currentX = 0;
            currentY = 0;
            activeCardEl.classList.remove('card-transition');
            activeCardEl.setPointerCapture(e.pointerId);
        });

        activeCardEl.addEventListener('pointermove', (e) => {
            if (!isDragging) return;
            currentX = e.clientX - startX;
            currentY = e.clientY - startY;
            const rotate = currentX * 0.04;
            activeCardEl.style.transform = `translateX(${currentX}px) rotate(${rotate}deg)`;

            const opacity = Math.min(Math.abs(currentX) / 110, 1);
            if (currentX < 0) {
                document.getElementById('badgeDelete').style.opacity = opacity;
                document.getElementById('badgeKeep').style.opacity = 0;
            } else if (currentX > 0) {
                document.getElementById('badgeKeep').style.opacity = opacity;
                document.getElementById('badgeDelete').style.opacity = 0;
            }
        });

        activeCardEl.addEventListener('pointerup', (e) => {
            if (!isDragging) return;
            isDragging = false;
            activeCardEl.releasePointerCapture(e.pointerId);

            const threshold = 110;
            if (Math.abs(currentY) > 120 && Math.abs(currentY) > Math.abs(currentX)) {
                // Swipe vertical: saltar foto sin clasificar
                skipCurrentPhoto();
                return;
            }
            if (currentX < -threshold) {
                triggerDecision('delete');
            } else if (currentX > threshold) {
                triggerDecision('keep');
            } else {
                // Regresar al centro si no superó el umbral
                activeCardEl.classList.add('card-transition');
                activeCardEl.style.transform = 'translateX(0px) rotate(0deg)';
                document.getElementById('badgeDelete').style.opacity = 0;
                document.getElementById('badgeKeep').style.opacity = 0;
            }
        });

        // Pinch-zoom básico sobre la tarjeta actual
        let pinchStartDist = 0;
        let isPinching = false;
        activeCardEl.addEventListener('touchstart', (e) => {
            if (e.touches.length === 2) {
                isPinching = true;
                isDragging = false;
                const dx = e.touches[0].clientX - e.touches[1].clientX;
                const dy = e.touches[0].clientY - e.touches[1].clientY;
                pinchStartDist = Math.hypot(dx, dy) || 1;
            }
        }, { passive: true });
        activeCardEl.addEventListener('touchmove', (e) => {
            if (!isPinching || e.touches.length !== 2) return;
            e.preventDefault();
            const dx = e.touches[0].clientX - e.touches[1].clientX;
            const dy = e.touches[0].clientY - e.touches[1].clientY;
            const dist = Math.hypot(dx, dy);
            const scale = Math.min(3, Math.max(1, dist / pinchStartDist));
            const currentImg = document.getElementById('currentCardImg');
            currentImg.style.transform = `scale(${scale})`;
            currentImg.style.transformOrigin = 'center center';
        }, { passive: false });
        activeCardEl.addEventListener('touchend', () => {
            if (!isPinching) return;
            isPinching = false;
            const currentImg = document.getElementById('currentCardImg');
            currentImg.style.transform = '';
        });

        // Atajos de teclado
        document.addEventListener('keydown', (e) => {
            // Si el Lightbox está abierto, controlar desde ahí
            if (!document.getElementById('lightboxModal').classList.contains('hidden')) {
                if (e.key === 'Escape' || e.key === ' ') {
                    e.preventDefault();
                    closeLightbox();
                } else if (e.key === 'ArrowLeft') {
                    e.preventDefault();
                    navigateLightbox(-1);
                } else if (e.key === 'ArrowRight') {
                    e.preventDefault();
                    navigateLightbox(1);
                }
                return;
            }

            if (document.getElementById('swipeView').classList.contains('hidden')) return;
            if (!document.getElementById('customModal').classList.contains('hidden')) return;

            if (e.key === 'ArrowLeft') {
                e.preventDefault();
                triggerDecision('delete');
            } else if (e.key === 'ArrowRight') {
                e.preventDefault();
                triggerDecision('keep');
            } else if (e.key === ' ') {
                e.preventDefault();
                openLightbox(currentIndex);
            } else if (e.key === 'ArrowDown' || (e.ctrlKey && e.key.toLowerCase() === 'z')) {
                e.preventDefault();
                undoLastAction();
            } else if (e.ctrlKey && e.key.toLowerCase() === 'y') {
                e.preventDefault();
                redoLastAction();
            }
        });

        // ==========================================
        // VISOR EXPANDIDO (LIGHTBOX)
        // ==========================================
        function openLightbox(index) {
            if (index < 0 || index >= photos.length) return;
            isDragging = false;
            currentX = currentY = 0;
            const card = document.getElementById('activeCard');
            card.classList.remove('card-transition', 'swipe-left', 'swipe-right');
            card.style.transform = 'translateX(0px) rotate(0deg)';
            card.style.opacity = '1';
            lightboxIndex = index;
            isLightboxZoomed = false;
            renderLightbox();
            document.getElementById('lightboxModal').classList.remove('hidden');
        }

        function closeLightbox() {
            const modal = document.getElementById('lightboxModal');
            modal.classList.add('hidden');
            document.getElementById('lbVideo').pause();
            lightboxIndex = -1;
            isLightboxZoomed = false;
            isDragging = false;
            currentX = currentY = 0;
            const card = document.getElementById('activeCard');
            card.classList.remove('card-transition', 'swipe-left', 'swipe-right');
            card.style.transform = 'translateX(0px) rotate(0deg)';
            card.style.opacity = '1';
            document.getElementById('badgeDelete').style.opacity = '0';
            document.getElementById('badgeKeep').style.opacity = '0';
        }

        function renderLightbox() {
            const photo = photos[lightboxIndex];
            if (!photo) return;
            const img = document.getElementById('lbImage');
            const video = document.getElementById('lbVideo');
            const container = document.getElementById('lbImageContainer');
            const muteBtn = document.getElementById('lbMuteBtn');
            video.pause();
            img.className = 'max-h-full max-w-full object-contain cursor-zoom-in';
            video.className = 'hidden max-h-full max-w-full object-contain';
            if (muteBtn) muteBtn.classList.add('hidden');
            container.classList.remove('items-start', 'justify-start', 'cursor-zoom-out');
            container.classList.add('items-center', 'justify-center', 'cursor-zoom-in');
            isLightboxZoomed = false;
            document.getElementById('btnZoomToggle').innerHTML = '<span>🔍 Ampliar (100%)</span>';
            if (isVideoMedia(photo)) {
                img.classList.add('hidden');
                img.removeAttribute('src');
                video.classList.remove('hidden');
                video.src = getPhotoUrl(photo);
                video.poster = photo.thumbnailUrl || '';
                video.load();
                video.controls = false;
                if (muteBtn) {
                    muteBtn.classList.remove('hidden');
                    updateMuteButton();
                }
            } else {
                video.classList.add('hidden');
                video.removeAttribute('src');
                video.load();
                img.classList.remove('hidden');
                img.src = getPhotoUrl(photo);
            }
            document.getElementById('lbTitle').textContent = photo.name + ' (' + (lightboxIndex + 1) + ' de ' + photos.length + ')';
            const dims = photo.width && photo.height ? ' • ' + photo.width + ' × ' + photo.height + ' px' : '';
            const length = isVideoMedia(photo) && photo.duration ? ' • ' + formatDuration(photo.duration) : '';
            const origin = photo.isFromDeletedFolder ? ' • [_ELIMINADAS]' : '';
            document.getElementById('lbMeta').textContent = formatBytes(photo.size) + dims + length + origin;
            const badge = document.getElementById('lbStatusBadge');
            if (photo.status === 'delete') { badge.textContent = 'Descartada'; badge.className = 'px-2.5 py-1 rounded-lg text-xs font-bold uppercase bg-rose-500/20 text-rose-400 border border-rose-500/30'; }
            else if (photo.status === 'keep') { badge.textContent = 'Conservada'; badge.className = 'px-2.5 py-1 rounded-lg text-xs font-bold uppercase bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'; }
            else { badge.textContent = 'Pendiente'; badge.className = 'px-2.5 py-1 rounded-lg text-xs font-bold uppercase bg-slate-800 text-slate-300 border border-slate-700'; }
        }

        function toggleLightboxZoom() {
            const media = isVideoMedia(photos[lightboxIndex]) ? document.getElementById('lbVideo') : document.getElementById('lbImage');
            const container = document.getElementById('lbImageContainer');
            const muteBtn = document.getElementById('lbMuteBtn');
            isLightboxZoomed = !isLightboxZoomed;
            media.className = isLightboxZoomed ? 'max-w-none max-h-none cursor-zoom-out' : 'max-h-full max-w-full object-contain cursor-zoom-in';
            container.classList.toggle('items-center', !isLightboxZoomed);
            container.classList.toggle('justify-center', !isLightboxZoomed);
            container.classList.toggle('items-start', isLightboxZoomed);
            container.classList.toggle('justify-start', isLightboxZoomed);
            container.classList.toggle('cursor-zoom-in', !isLightboxZoomed);
            container.classList.toggle('cursor-zoom-out', isLightboxZoomed);
            document.getElementById('btnZoomToggle').innerHTML = isLightboxZoomed ? '<span>🔎 Ajustar a pantalla</span>' : '<span>🔍 Ampliar (100%)</span>';
            if (isVideoMedia(photos[lightboxIndex])) {
                const video = document.getElementById('lbVideo');
                video.controls = isLightboxZoomed;
                if (muteBtn) {
                    if (isLightboxZoomed) {
                        muteBtn.classList.add('hidden');
                    } else {
                        muteBtn.classList.remove('hidden');
                        updateMuteButton();
                    }
                }
            }
        }

        function navigateLightbox(delta) {
            const next = lightboxIndex + delta;
            if (next >= 0 && next < photos.length) {
                lightboxIndex = next;
                isLightboxZoomed = false;
                renderLightbox();
            }
        }

        function setDecisionFromLightbox(decision) {
            const index = lightboxIndex;
            const photo = photos[index];
            if (!photo || (decision !== 'delete' && decision !== 'keep')) return;
            const wasPending = photo.status === 'pending';
            photo.status = decision;
            if (wasPending) redoStack = [];
            updateHeaderStats();
            const inSwipe = !document.getElementById('swipeView').classList.contains('hidden');
            if (inSwipe && index === currentIndex) {
                if (wasPending) historyStack.push({ index: index, decision: decision });
                redoStack = [];
                isBusy = true;
                closeLightbox();
                let next = index + 1;
                while (next < photos.length && photos[next].status !== 'pending') next++;
                currentIndex = next;
                renderCurrentCard();
                return;
            }
            if (!document.getElementById('summaryView').classList.contains('hidden')) {
                updateSummaryStats();
                renderReviewGrid();
            }
            renderLightbox();
            showToast('Marcada para ' + (decision === 'delete' ? 'aplicar' : 'conservar'));
        }

        // ==========================================
        // CONTROLES DE VIDEO EN LIGHTBOX
        // ==========================================
        function toggleVideoPlayPause(e) {
            const video = document.getElementById('lbVideo');
            if (!video || video.classList.contains('hidden')) return;
            if (isLightboxZoomed) return;
            e.stopPropagation();
            if (video.paused) {
                video.play();
            } else {
                video.pause();
            }
        }

        function toggleVideoMute() {
            const video = document.getElementById('lbVideo');
            if (!video) return;
            video.muted = !video.muted;
            updateMuteButton();
        }

        function updateMuteButton() {
            const video = document.getElementById('lbVideo');
            const btn = document.getElementById('lbMuteBtn');
            if (!video || !btn) return;
            btn.innerHTML = video.muted ? '🔇' : '🔊';
        }

        // ==========================================
        // 4. PANTALLA DE REVISIÓN Y VERIFICACIÓN
        // ==========================================
        function showReviewModal() {
            finishSwiping();
        }

        function resumeSwiping() {
            // Buscar la primera foto pendiente
            const firstPending = photos.findIndex(p => p.status === 'pending');
            if (firstPending === -1) {
                showToast("✅ Ya has clasificado todas las fotos.");
                return;
            }
            currentIndex = firstPending;
            document.getElementById('summaryView').classList.add('hidden');
            document.getElementById('swipeView').classList.remove('hidden');
            document.getElementById('swipeView').classList.add('flex');
            isBusy = true;
            renderCurrentCard();
        }

        function confirmRestartClassification() {
            document.getElementById('modalTitle').textContent = "¿Empezar de cero?";
            document.getElementById('modalBody').innerHTML = `Se reiniciará el estado de las <strong>${photos.length} imágenes</strong> a "Pendiente" para que puedas volver a clasificarlas desde la primera foto. No se borrará ningún archivo.`;
            
            const confirmBtn = document.getElementById('modalConfirmBtn');
            confirmBtn.textContent = "Sí, empezar de cero";
            confirmBtn.className = "px-4 py-2 rounded-xl bg-amber-500 hover:bg-amber-600 text-slate-950 text-sm font-bold transition";
            confirmBtn.onclick = restartClassification;
            
            document.getElementById('customModal').classList.remove('hidden');
        }

        function restartClassification() {
            closeModal();
            photos.forEach(p => p.status = 'pending');
            currentIndex = 0;
            historyStack = [];

            updateHeaderStats();
            isBusy = true;
            document.getElementById('summaryView').classList.add('hidden');
            document.getElementById('swipeView').classList.remove('hidden');
            document.getElementById('swipeView').classList.add('flex');
            renderCurrentCard();
            showToast("🔄 Clasificación reiniciada desde la foto 1");
        }

        function finishSwiping() {
            document.getElementById('swipeView').classList.add('hidden');
            document.getElementById('swipeView').classList.remove('flex');
            document.getElementById('summaryView').classList.remove('hidden');
            document.getElementById('summaryView').classList.add('flex');

            updateSummaryStats();
            switchReviewTab('delete');
        }

        function updateSummaryStats() {
            const deleteList = photos.filter(p => p.status === 'delete');
            const keepList = photos.filter(p => p.status === 'keep');
            const pendingList = photos.filter(p => p.status === 'pending');
            const totalDeleteBytes = deleteList.reduce((acc, p) => acc + p.size, 0);

            document.getElementById('statDeleteCount').textContent = deleteList.length;
            document.getElementById('statDeleteSize').textContent = `${formatBytes(totalDeleteBytes)} a liberar`;
            document.getElementById('statKeepCount').textContent = keepList.length;
            document.getElementById('statPendingCount').textContent = pendingList.length;

            document.getElementById('tabDeleteNum').textContent = deleteList.length;
            document.getElementById('tabKeepNum').textContent = keepList.length;
            document.getElementById('tabPendingNum').textContent = pendingList.length;
            document.getElementById('btnTrashCount').textContent = photos.filter(p => p.status === 'delete' && !p.isFromDeletedFolder).length + photos.filter(p => p.status === 'keep' && p.isFromDeletedFolder).length;

            // Mostrar u ocultar botón de seguir clasificando
            const btnResume = document.getElementById('btnResumeSwipe');
            if (pendingList.length > 0) {
                btnResume.classList.remove('hidden');
            } else {
                btnResume.classList.add('hidden');
            }

            // Mostrar u ocultar sección de borrado directo según el modo
            if (isDirectMode && directoryHandle) {
                document.getElementById('directDeleteSection').classList.remove('hidden');
                document.getElementById('statModeLabel').textContent = 'Acceso Directo';
                document.getElementById('statModeLabel').className = 'text-sm font-bold text-emerald-400 mt-1';
            } else {
                document.getElementById('directDeleteSection').classList.add('hidden');
                document.getElementById('statModeLabel').textContent = 'Modo Script';
                document.getElementById('statModeLabel').className = 'text-sm font-bold text-orange-400 mt-1';
            }
        }

        function switchReviewTab(tab) {
            currentReviewTab = tab;
            const tabDel = document.getElementById('tabDelete');
            const tabKeep = document.getElementById('tabKeep');
            const tabPend = document.getElementById('tabPending');

            const inactiveClass = "px-4 py-1.5 rounded-xl text-sm font-medium text-slate-400 hover:text-slate-200 transition";
            tabDel.className = inactiveClass;
            tabKeep.className = inactiveClass;
            tabPend.className = inactiveClass;

            if (tab === 'delete') {
                tabDel.className = "px-4 py-1.5 rounded-xl text-sm font-semibold bg-rose-500/15 text-rose-400 border border-rose-500/30 transition";
            } else if (tab === 'keep') {
                tabKeep.className = "px-4 py-1.5 rounded-xl text-sm font-semibold bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 transition";
            } else {
                tabPend.className = "px-4 py-1.5 rounded-xl text-sm font-semibold bg-slate-800 text-slate-200 border border-slate-700 transition";
            }

            renderReviewGrid();
        }

        // Genera una miniatura JPEG pequeña y la conserva en caché durante la sesión.
        // La imagen original nunca se modifica y sigue utilizándose en Swipe y Lightbox.
        async function getReviewThumbnail(photo) {
            if (photo.thumbnailUrl) return photo.thumbnailUrl;
            if (photo.thumbnailPromise) return photo.thumbnailPromise;

            photo.thumbnailPromise = (async () => {
                let blob = null;
                try {
                    if (isVideoMedia(photo)) {
                        blob = await createVideoThumbnail(photo);
                    } else if (thumbWorker) {
                        blob = await new Promise((resolve) => {
                            const id = crypto.randomUUID();
                            const handler = (ev) => {
                                if (ev.data.id !== id) return;
                                thumbWorker.removeEventListener('message', handler);
                                resolve(ev.data.error ? null : ev.data.blob);
                            };
                            thumbWorker.addEventListener('message', handler);
                            thumbWorker.postMessage({ id, file: photo.file, maxEdge: THUMBNAIL_MAX_EDGE });
                        });
                    }

                    if (!blob) {
                        let bitmap = null;
                        if ('createImageBitmap' in window) {
                            bitmap = await createImageBitmap(photo.file, { imageOrientation: 'from-image' });
                        } else {
                            const image = new Image();
                            image.src = getPhotoUrl(photo);
                            if (image.decode) await image.decode();
                            else await new Promise((resolve, reject) => {
                                image.onload = resolve;
                                image.onerror = reject;
                            });
                            bitmap = image;
                        }

                        const scale = Math.min(1, THUMBNAIL_MAX_EDGE / Math.max(bitmap.width, bitmap.height));
                        const width = Math.max(1, Math.round(bitmap.width * scale));
                        const height = Math.max(1, Math.round(bitmap.height * scale));
                        const canvas = document.createElement('canvas');
                        canvas.width = width;
                        canvas.height = height;
                        const ctx = canvas.getContext('2d', { alpha: false });
                        ctx.drawImage(bitmap, 0, 0, width, height);

                        blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.76));
                        if (bitmap && typeof bitmap.close === 'function') bitmap.close();
                    }

                    if (!blob) throw new Error('No se pudo generar la miniatura');
                    photo.thumbnailUrl = URL.createObjectURL(blob);
                    return photo.thumbnailUrl;
                } catch (err) {
                    console.warn(`No se pudo crear miniatura para ${photo.name}:`, err);
                    // Fallback compatible: solo se carga si esa miniatura llegó a ser visible.
                    return isVideoMedia(photo) ? '' : getPhotoUrl(photo);
                } finally {
                    photo.thumbnailPromise = null;
                }
            })();

            return photo.thumbnailPromise;
        }

        async function createVideoThumbnail(photo) {
            const video = document.createElement('video');
            video.muted = true;
            video.playsInline = true;
            video.preload = 'metadata';
            video.src = getPhotoUrl(photo);
            try {
                await new Promise((resolve, reject) => {
                    const timer = setTimeout(() => reject(new Error('timeout')), 6000);
                    video.onloadeddata = () => { clearTimeout(timer); resolve(); };
                    video.onerror = () => { clearTimeout(timer); reject(new Error('video load failed')); };
                    video.load();
                });
                const scale = Math.min(1, THUMBNAIL_MAX_EDGE / Math.max(video.videoWidth, video.videoHeight));
                const canvas = document.createElement('canvas');
                canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
                canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
                canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
                return await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.76));
            } finally { video.pause(); video.removeAttribute('src'); video.load(); }
        }

        function observeReviewThumbnail(img, photo) {
            const loadThumbnail = async () => {
                if (!img.isConnected || img.dataset.loading === 'true') return;
                img.dataset.loading = 'true';
                const src = await getReviewThumbnail(photo);
                if (img.isConnected && src) img.src = src;
            };

            if ('IntersectionObserver' in window) {
                if (!reviewObserver) {
                    reviewObserver = new IntersectionObserver(entries => {
                        entries.forEach(entry => {
                            if (entry.isIntersecting) {
                                const target = entry.target;
                                reviewObserver.unobserve(target);
                                loadThumbnailForElement(target);
                            }
                        });
                    }, { root: document.getElementById('reviewGrid'), rootMargin: '250px' });
                }
                img._loadThumbnail = loadThumbnail;
                reviewObserver.observe(img);
            } else {
                loadThumbnail();
            }
        }

        function loadThumbnailForElement(img) {
            if (img._loadThumbnail) img._loadThumbnail();
        }

        function renderReviewGrid(resetPage = true) {
            const grid = document.getElementById('reviewGrid');
            if (reviewObserver) {
                reviewObserver.disconnect();
                reviewObserver = null;
            }
            if (resetPage) reviewVisibleCount = REVIEW_PAGE_SIZE;
            grid.innerHTML = '';

            const filtered = photos.filter(p => p.status === currentReviewTab && (!reviewSearchQuery || p.name.toLowerCase().includes(reviewSearchQuery)));
            if (filtered.length === 0) {
                grid.innerHTML = `<div class="col-span-full py-10 text-center text-slate-500 text-sm">No hay archivos multimedia en esta categoría.</div>`;
                return;
            }

            const visiblePhotos = filtered.slice(0, reviewVisibleCount);
            visiblePhotos.forEach(photo => {
                const globalIndex = photos.findIndex(p => p.id === photo.id);
                const item = document.createElement('div');
                item.className = "group relative aspect-square bg-slate-950 rounded-xl overflow-hidden border border-slate-800 cursor-pointer hover:border-slate-500 transition";
                item.tabIndex = 0;
                item.setAttribute("role","button");
                item.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); togglePhotoStatus(photo.id); } });
                item.title = `${photo.name} - Clic para cambiar estado`;
                item.onclick = () => togglePhotoStatus(photo.id);

                let badgeColor = 'bg-slate-700 text-slate-200';
                let badgeText = '?';
                if (photo.status === 'delete') {
                    badgeColor = 'bg-rose-500 text-white';
                    badgeText = '✕';
                } else if (photo.status === 'keep') {
                    badgeColor = 'bg-emerald-500 text-slate-950';
                    badgeText = '✓';
                }

                item.innerHTML = `
                    <img data-review-thumbnail="true" alt="${escapeHtml(photo.name)}" class="w-full h-full object-cover group-hover:scale-105 transition duration-200" style="background:#020617" />
                    ${isVideoMedia(photo) ? `<span class="absolute inset-x-0 top-1/2 -translate-y-1/2 text-white text-xs font-bold drop-shadow">▶ VÍDEO</span>` : ""}
                    <button type="button" class="zoom-btn absolute top-1.5 left-1.5 w-7 h-7 rounded-lg bg-slate-900/85 hover:bg-sky-500 text-slate-200 hover:text-white border border-slate-700 flex items-center justify-center shadow-md opacity-80 group-hover:opacity-100 transition" title="Ampliar imagen">
                        <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"></path></svg>
                    </button>
                    ${photo.isFromDeletedFolder ? `<span class="absolute bottom-7 left-1.5 bg-amber-500/90 text-slate-950 text-[10px] font-extrabold px-1.5 py-0.5 rounded shadow">_ELIMINADAS</span>` : ''}
                    <div class="absolute top-1.5 right-1.5 w-6 h-6 rounded-full ${badgeColor} text-xs font-bold flex items-center justify-center shadow-md">${badgeText}</div>
                    ${photo.isDuplicate ? `<span class="absolute bottom-7 right-1.5 bg-indigo-500/90 text-white text-[10px] font-extrabold px-1.5 py-0.5 rounded shadow">DUP</span>` : ''}
                    <div class="absolute inset-x-0 bottom-0 bg-black/80 px-2 py-1.5 text-[11px] text-slate-200 truncate">${escapeHtml(photo.name)}</div>
                `;

                const zoomBtn = item.querySelector('.zoom-btn');
                zoomBtn.onclick = (e) => {
                    e.stopPropagation();
                    openLightbox(globalIndex);
                };

                const thumbnailImg = item.querySelector('[data-review-thumbnail]');
                grid.appendChild(item);
                observeReviewThumbnail(thumbnailImg, photo);
            });

            if (filtered.length > visiblePhotos.length) {
                const remaining = filtered.length - visiblePhotos.length;
                const more = document.createElement('button');
                more.type = 'button';
                more.className = 'col-span-full py-3 px-4 rounded-xl bg-slate-800 hover:bg-slate-700 border border-slate-700 text-sm font-semibold text-slate-200 transition';
                more.textContent = `Cargar ${Math.min(REVIEW_PAGE_SIZE, remaining)} más (${remaining} restantes)`;
                more.onclick = () => {
                    reviewVisibleCount += REVIEW_PAGE_SIZE;
                    renderReviewGrid(false);
                };
                grid.appendChild(more);
            }
        }

        function togglePhotoStatus(id) {
            const photo = photos.find(p => p.id === id);
            if (!photo) return;
            // Si estaba pendiente o conservar -> pasa a eliminar; si estaba en eliminar -> pasa a conservar
            photo.status = photo.status === 'delete' ? 'keep' : 'delete';
            updateHeaderStats();
            updateSummaryStats();
            renderReviewGrid();
            showToast(`🔄 ${photo.name} movida a ${photo.status === 'delete' ? 'Eliminar' : 'Conservar'}`);
        }

        // ==========================================
        // 5. EJECUCIÓN DE LIMPIEZA (DIRECTA O SCRIPT)
        // ==========================================
        function confirmDirectDelete() { confirmApplyChanges('direct'); }

        function closeModal() {
            document.getElementById('customModal').classList.add('hidden');
        }

        function getCleanupPlan() {
            return {
                move: photos.filter(photo => photo.status === 'delete' && !photo.isFromDeletedFolder),
                restore: photos.filter(photo => photo.status === 'keep' && photo.isFromDeletedFolder)
            };
        }

        function confirmApplyChanges(mode, os) {
            const plan = getCleanupPlan();
            if (!plan.move.length && !plan.restore.length) {
                showToast('No hay cambios pendientes para aplicar.');
                return;
            }
            const list = (items) => items.slice(0, 5).map(photo => '<li>' + escapeHtml(photo.name) + (isVideoMedia(photo) ? ' <span class="text-sky-300">(vídeo)</span>' : '') + '</li>').join('') + (items.length > 5 ? '<li>… y ' + (items.length - 5) + ' más</li>' : '');
            const scriptMode = mode === 'script';
            document.getElementById('modalTitle').textContent = scriptMode ? 'Revisar script de cambios' : '¿Aplicar estos cambios?';
            let body = '<p>Antes de continuar, revisa el plan:</p><ul class="mt-3 space-y-2 list-disc pl-5">';
            body += '<li><strong>' + plan.move.length + '</strong> archivo(s) descartado(s) se moverán a <code>_ELIMINADAS</code>' + (plan.move.length ? '<ul class="mt-1 list-disc pl-5 text-xs">' + list(plan.move) + '</ul>' : '') + '</li>';
            body += '<li><strong>' + plan.restore.length + '</strong> archivo(s) conservado(s) volverán de <code>_ELIMINADAS</code> a la carpeta principal' + (plan.restore.length ? '<ul class="mt-1 list-disc pl-5 text-xs">' + list(plan.restore) + '</ul>' : '') + '</li></ul>';
            body += '<p class="mt-3 text-amber-300">No se borra nada permanentemente. ' + (scriptMode ? 'Revísalo antes de ejecutarlo. Trabajará en la carpeta donde esté guardado; colócalo junto a tus fotos (o edita PHOTOS_DIR en el .sh). Si ya existe un archivo con el mismo nombre, lo omitirá para no sobrescribirlo.' : 'Puedes revisar los archivos de _ELIMINADAS y recuperarlos después.') + '</p>';
            document.getElementById('modalBody').innerHTML = body;
            const button = document.getElementById('modalConfirmBtn');
            button.textContent = scriptMode ? 'Generar script' : 'Aplicar cambios';
            button.className = 'px-4 py-2 rounded-xl bg-rose-500 hover:bg-rose-600 text-white text-sm font-bold transition';
            button.onclick = () => scriptMode ? downloadCleanupScript(os) : moveDirectToTrash();
            document.getElementById('customModal').classList.remove('hidden');
        }

        async function findUnusedName(directory, originalName) {
            const dot = originalName.lastIndexOf('.');
            const hasExtension = dot > 0;
            const base = hasExtension ? originalName.slice(0, dot) : originalName;
            const ext = hasExtension ? originalName.slice(dot) : '';
            for (let i = 0; i < 10000; i++) {
                const name = i === 0 ? originalName : base + ' (' + i + ')' + ext;
                try {
                    await directory.getFileHandle(name, { create: false });
                } catch (error) {
                    if (error.name === 'NotFoundError') return name;
                    throw error;
                }
            }
            throw new Error('No se encontró un nombre libre para el archivo.');
        }

        async function moveWithoutOverwrite(photo, sourceDir, destinationDir) {
            let targetName = await findUnusedName(destinationDir, photo.name);
            if (typeof photo.handle.move === 'function') {
                try {
                    await photo.handle.move(destinationDir, targetName);
                    return { name: targetName, handle: await destinationDir.getFileHandle(targetName) };
                } catch (moveError) {
                    console.info('Movimiento directo no disponible; usando copia segura.', moveError);
                    // The destination may have appeared between the collision check and move().
                    targetName = await findUnusedName(destinationDir, photo.name);
                }
            }
            const file = await photo.handle.getFile();
            const destination = await destinationDir.getFileHandle(targetName, { create: true });
            const writable = await destination.createWritable({ keepExistingData: false });
            try {
                await writable.write(file);
                await writable.close();
            } catch (error) {
                try { await writable.abort(); } catch (_) {}
                try { await destinationDir.removeEntry(targetName); } catch (_) {}
                throw error;
            }
            await sourceDir.removeEntry(photo.name);
            return { name: targetName, handle: destination };
        }

        async function moveDirectToTrash() {
            if (!isDirectMode || !directoryHandle) return;
            const deleteList = photos.filter(p => p.status === 'delete' && !p.isFromDeletedFolder);
            const restoreList = photos.filter(p => p.status === 'keep' && p.isFromDeletedFolder);
            if (deleteList.length === 0 && restoreList.length === 0) return;

            closeModal();
            let moved = 0, restored = 0;
            try {
                if (!deletedDirHandle) deletedDirHandle = await directoryHandle.getDirectoryHandle('_ELIMINADAS', { create: true });
                for (const photo of deleteList) {
                    const result = await moveWithoutOverwrite(photo, directoryHandle, deletedDirHandle);
                    photo.name = result.name;
                    photo.relativePath = '_ELIMINADAS/' + result.name;
                    photo.isFromDeletedFolder = true;
                    photo.handle = result.handle;
                    moved++;
                }
                for (const photo of restoreList) {
                    const result = await moveWithoutOverwrite(photo, deletedDirHandle, directoryHandle);
                    photo.name = result.name;
                    photo.relativePath = result.name;
                    photo.isFromDeletedFolder = false;
                    photo.handle = result.handle;
                    restored++;
                }
                updateHeaderStats();
                updateSummaryStats();
                renderReviewGrid();
                showToast('✅ ' + moved + ' movidas a _ELIMINADAS' + (restored > 0 ? ' y ' + restored + ' recuperadas' : '') + '.');
            } catch (err) {
                console.error(err);
                updateHeaderStats();
                updateSummaryStats();
                renderReviewGrid();
                showToast('⚠️ Se completaron ' + moved + ' movimientos y ' + restored + ' recuperaciones antes del error.');
            }
        }

        async function downloadCleanupScript(os) {
            closeModal();
            const plan = getCleanupPlan();
            if (!plan.move.length && !plan.restore.length) { showToast('No hay cambios pendientes para incluir.'); return; }
            const quoteShell = name => "'" + name.replace(/'/g, "'\\''") + "'";
            let content = '';
            let filename = '';
            if (os === 'win') {
                filename = 'photoswiper_aplicar.bat';
                content = '@echo off\r\nchcp 65001 > nul\r\nsetlocal\r\nrem Carpeta con las fotos: carpeta donde está este .bat\r\nset "PHOTOS_DIR=%~dp0"\r\npushd "%PHOTOS_DIR%"\r\necho PhotoSwiper - cambios\r\necho Carpeta: %CD%\r\n';
                if (plan.move.length) {
                    content += 'if not exist "_ELIMINADAS" mkdir "_ELIMINADAS"\r\n';
                    plan.move.forEach(photo => {
                        const safe = photo.name.replace(/%/g, '%%').replace(/[\r\n]/g, '');
                        content += 'if exist "_ELIMINADAS\\' + safe + '" (echo Omitido: ya existe el destino, no se sobrescribe.) else if exist "' + safe + '" move "' + safe + '" "_ELIMINADAS\\"\r\n';
                    });
                }
                plan.restore.forEach(photo => {
                    const safe = photo.name.replace(/%/g, '%%').replace(/[\r\n]/g, '');
                    content += 'if exist "' + safe + '" (echo Omitido: ya existe el destino, no se sobrescribe.) else if exist "_ELIMINADAS\\' + safe + '" move "_ELIMINADAS\\' + safe + '" ".\\"\r\n';
                });
                content += 'echo Listo. Los descartados quedan en _ELIMINADAS; no se borran permanentemente.\r\npopd\r\npause\r\n';
            } else {
                filename = 'photoswiper_aplicar.sh';
                content = '#!/usr/bin/env bash\nset -e\n# Carpeta de fotos: por defecto, la carpeta donde guardes este script.\n# Si el script está en otro sitio, cambia esta ruta antes de ejecutarlo.\nSCRIPT_DIR="$(cd -- "$(dirname -- "$0")" && pwd)"\nPHOTOS_DIR="$SCRIPT_DIR"\ncd -- "$PHOTOS_DIR"\nprintf "PhotoSwiper - carpeta: %s\\n" "$PHOTOS_DIR"\n';
                if (plan.move.length) {
                    content += 'mkdir -p -- "_ELIMINADAS"\n';
                    plan.move.forEach(photo => { const q = quoteShell(photo.name); const dest = quoteShell('_ELIMINADAS/' + photo.name); content += 'if [ -e ' + dest + ' ]; then printf "Omitido: ya existe el destino; no se sobrescribió.\\n"; elif [ -f ' + q + ' ]; then mv -n ' + q + ' ' + quoteShell('_ELIMINADAS/') + '; fi\n'; });
                }
                plan.restore.forEach(photo => { const q = quoteShell(photo.name); const src = quoteShell('_ELIMINADAS/' + photo.name); content += 'if [ -e ' + q + ' ]; then printf "Omitido: ya existe el destino; no se sobrescribió.\\n"; elif [ -f ' + src + ' ]; then mv -n ' + src + ' ./; fi\n'; });
                content += 'echo "Listo. Los descartados quedan en _ELIMINADAS; no se borran permanentemente."\n';
            }
            let saveDirHandle = directoryHandle;
            if (!saveDirHandle && 'showDirectoryPicker' in window) {
                if (pickerOpen) {
                    showToast('Ya hay un selector de carpeta abierto; termina ese primero.');
                } else {
                    pickerOpen = true;
                    try { saveDirHandle = await window.showDirectoryPicker({ mode: 'readwrite' }); }
                    catch (err) { saveDirHandle = null; }
                    finally { pickerOpen = false; }
                }
            }
            if (saveDirHandle) {
                try {
                    filename = await findUnusedName(saveDirHandle, filename);
                    const fileHandle = await saveDirHandle.getFileHandle(filename, { create: true });
                    const writable = await fileHandle.createWritable();
                    await writable.write(content);
                    await writable.close();
                    showToast(filename + ' guardado en la carpeta principal de fotos.');
                    autoCopyExecutionCommand(os);
                    return;
                } catch (err) { console.warn('No se pudo escribir en la carpeta, se descargará el script:', err); }
            }
            const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
            const url = URL.createObjectURL(blob);
            const anchor = document.createElement('a');
            anchor.href = url; anchor.download = filename;
            document.body.appendChild(anchor); anchor.click(); anchor.remove(); URL.revokeObjectURL(url);
            autoCopyExecutionCommand(os);
            showToast('Script descargado. Colócalo en la carpeta principal de fotos antes de ejecutarlo.');
        }

        function copyTerminalCommand() {
            const cmd = `chmod +x photoswiper_aplicar.sh && ./photoswiper_aplicar.sh`;
            copyTextToClipboard(cmd);
            showToast(`📋 Copiado: ${cmd}`);
        }

        function autoCopyExecutionCommand(os) {
            const cmd = os === 'win'
                ? `photoswiper_aplicar.bat`
                : `chmod +x photoswiper_aplicar.sh && ./photoswiper_aplicar.sh`;
            const ok = copyTextToClipboard(cmd);
            if (ok) {
                showToast(`📋 Comando copiado al portapapeles: ${cmd}`);
            } else {
                showToast(`📋 Ejecuta: ${cmd}`);
            }
        }

        function copyTextToClipboard(text) {
            try {
                if (navigator.clipboard && navigator.clipboard.writeText) {
                    navigator.clipboard.writeText(text);
                    return true;
                }
            } catch (e) {}
            try {
                const tempInput = document.createElement('textarea');
                tempInput.value = text;
                tempInput.style.position = 'fixed';
                tempInput.style.opacity = '0';
                document.body.appendChild(tempInput);
                tempInput.select();
                const ok = document.execCommand('copy');
                document.body.removeChild(tempInput);
                return ok;
            } catch (e) {
                return false;
            }
        }

        // ==========================================
        // UTILIDADES
        // ==========================================
        function resetApp() {
            photos.forEach(p => {
                URL.revokeObjectURL(p.url);
                if (p.thumbnailUrl) URL.revokeObjectURL(p.thumbnailUrl);
            });
            if (reviewObserver) { reviewObserver.disconnect(); reviewObserver = null; }
            photos = [];
            currentIndex = 0;
            historyStack = [];
            redoStack = [];
            directoryHandle = null;
            deletedDirHandle = null;
            isDirectMode = false;

            document.getElementById('summaryView').classList.add('hidden');
            document.getElementById('swipeView').classList.add('hidden');
            document.getElementById('headerControls').classList.add('hidden');
            document.getElementById('setupView').classList.remove('hidden');
            document.getElementById('fileInput').value = '';
        }

        function exportReport() {
            const rows = [['nombre','estado','tamano_bytes','ancho','alto','desde_eliminadas']];
            photos.forEach(p => {
                rows.push([p.name, p.status, p.size, p.width||'', p.height||'', p.isFromDeletedFolder?'si':'no']);
            });
            const csv = rows.map(r => r.map(v => `"${String(v).replace(/"/g,'""')}"`).join(',')).join('\n');
            const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url; a.download = 'photoswiper_reporte.csv';
            document.body.appendChild(a); a.click(); document.body.removeChild(a);
            URL.revokeObjectURL(url);
            showToast('📊 Reporte CSV descargado');
        }

        async function detectDuplicates() {
            if (!dupWorker) { showToast('⚠️ Web Worker no disponible'); return; }
            showToast('🔍 Analizando duplicados (pHash)...');
            const photoHashes = new Map();
            let done = 0;
            const imagePhotos = photos.filter(photo => !isVideoMedia(photo));
            const tasks = imagePhotos.map(photo => new Promise((resolve) => {
                const id = crypto.randomUUID();
                const handler = (ev) => {
                    if (ev.data.id !== id) return;
                    dupWorker.removeEventListener('message', handler);
                    if (!ev.data.error) photoHashes.set(photo.id, ev.data.hash);
                    done++;
                    resolve();
                };
                dupWorker.addEventListener('message', handler);
                dupWorker.postMessage({ id, file: photo.file });
            }));
            await Promise.all(tasks);

            function hamming(a, b) {
                if (!a || !b || a.length !== b.length) return Infinity;
                let d = 0;
                for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++;
                return d;
            }

            const THRESHOLD = 8;
            const photoList = imagePhotos.filter(p => photoHashes.has(p.id));
            const hashRecordMap = new Map();
            photoList.forEach((photo, photoIndex) => {
                const hash = photoHashes.get(photo.id);
                if (!hashRecordMap.has(hash)) hashRecordMap.set(hash, { hash, photoIndexes: [] });
                hashRecordMap.get(hash).photoIndexes.push(photoIndex);
            });
            const hashRecords = [...hashRecordMap.values()];
            const parent = hashRecords.map((_, index) => index);
            const rank = hashRecords.map(() => 0);
            function find(index) {
                while (parent[index] !== index) {
                    parent[index] = parent[parent[index]];
                    index = parent[index];
                }
                return index;
            }
            function union(a, b) {
                let ra = find(a), rb = find(b);
                if (ra === rb) return;
                if (rank[ra] < rank[rb]) [ra, rb] = [rb, ra];
                parent[rb] = ra;
                if (rank[ra] === rank[rb]) rank[ra]++;
            }
            // Cualquier par a distancia Hamming <= 8 comparte al menos una
            // banda idéntica al dividir el hash en 9 segmentos.
            const bandCount = THRESHOLD + 1;
            const bandMaps = Array.from({ length: bandCount }, () => new Map());
            const ranges = Array.from({ length: bandCount }, (_, band) => [
                Math.floor(band * 64 / bandCount), Math.floor((band + 1) * 64 / bandCount)
            ]);
            for (let i = 0; i < hashRecords.length; i++) {
                const hash = hashRecords[i].hash;
                const candidates = new Set();
                for (let band = 0; band < bandCount; band++) {
                    const [start, end] = ranges[band];
                    const bucket = bandMaps[band].get(hash.slice(start, end));
                    if (bucket) bucket.forEach(index => candidates.add(index));
                }
                for (const other of candidates) {
                    if (hamming(hash, hashRecords[other].hash) <= THRESHOLD) union(i, other);
                }
                for (let band = 0; band < bandCount; band++) {
                    const [start, end] = ranges[band];
                    const key = hash.slice(start, end);
                    if (!bandMaps[band].has(key)) bandMaps[band].set(key, []);
                    bandMaps[band].get(key).push(i);
                }
            }
            const groupMap = new Map();
            hashRecords.forEach((record, index) => {
                const root = find(index);
                if (!groupMap.has(root)) groupMap.set(root, []);
                record.photoIndexes.forEach(photoIndex => groupMap.get(root).push(photoList[photoIndex]));
            });
            const groups = [...groupMap.values()];

            let dupCount = 0;
            groups.forEach(group => {
                const isDup = group.length > 1;
                group.forEach(p => { p.isDuplicate = isDup; });
                if (isDup) dupCount += group.length;
            });
            // fotos sin hash
            imagePhotos.filter(p => !photoHashes.has(p.id)).forEach(p => { p.isDuplicate = false; });

            saveStateIDB();
            renderReviewGrid();
            showToast(`🔍 ${groups.length} grupos analizados, ${dupCount} fotos duplicadas marcadas`);
        }

        function exportReportJSON() {
            const data = photos.map(p => ({ name: p.name, status: p.status, size: p.size, width: p.width, height: p.height, isFromDeletedFolder: p.isFromDeletedFolder, isDuplicate: !!p.isDuplicate }));
            const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url; a.download = 'photoswiper_reporte.json';
            document.body.appendChild(a); a.click(); document.body.removeChild(a);
            URL.revokeObjectURL(url);
            showToast('🧾 Reporte JSON descargado');
        }

        function escapeHtml(value) {
            return String(value)
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#39;');
        }

        function formatBytes(bytes, decimals = 1) {
            if (!+bytes) return '0 Bytes';
            const k = 1024;
            const dm = decimals < 0 ? 0 : decimals;
            const sizes = ['Bytes', 'KB', 'MB', 'GB'];
            const i = Math.floor(Math.log(bytes) / Math.log(k));
            return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
        }

        function getPhotoUrl(photo) {
            if (!photo.url) photo.url = URL.createObjectURL(photo.file);
            return photo.url;
        }

        function releaseDistantUrls() {
            const KEEP = 4;
            photos.forEach((p, i) => {
                if (Math.abs(i - currentIndex) <= KEEP) return;
                if (p.url) { URL.revokeObjectURL(p.url); p.url = null; }
            });
        }

        const IDB_NAME = 'photoswiper_db';
        const IDB_STORE = 'states';
        let idbPromise = null;
        let stateSaveTimer = null;
        function openIDB() {
            if (idbPromise) return idbPromise;
            idbPromise = new Promise((resolve, reject) => {
                const req = indexedDB.open(IDB_NAME, 1);
                req.onupgradeneeded = () => {
                    const db = req.result;
                    if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE, { keyPath: 'key' });
                };
                req.onsuccess = () => {
                    const db = req.result;
                    db.onversionchange = () => { db.close(); idbPromise = null; };
                    resolve(db);
                };
                req.onerror = () => reject(req.error);
            }).catch(error => { idbPromise = null; throw error; });
            return idbPromise;
        }
        function getPhotoStateKey(photo) {
            const path = photo.relativePath || (photo.isFromDeletedFolder ? '_ELIMINADAS/' + photo.name : photo.name);
            return path + '|' + photo.size + '|' + (photo.file && photo.file.lastModified || 0);
        }
        function getSessionScope() {
            const folderName = directoryHandle && directoryHandle.name ? directoryHandle.name : '';
            const value = folderName + String.fromCharCode(31) + photos.map(getPhotoStateKey).sort().join(String.fromCharCode(30));
            let hash = 2166136261;
            for (let i = 0; i < value.length; i++) { hash ^= value.charCodeAt(i); hash = Math.imul(hash, 16777619); }
            return 'session-' + (hash >>> 0).toString(16) + '-' + photos.length;
        }
        function saveStateIDB() {
            clearTimeout(stateSaveTimer);
            stateSaveTimer = setTimeout(async () => {
                try {
                    const db = await openIDB();
                    const tx = db.transaction(IDB_STORE, 'readwrite');
                    tx.objectStore(IDB_STORE).put({
                        key: 'last', scope: getSessionScope(),
                        data: photos.map(p => ({ key: getPhotoStateKey(p), status: p.status, isDuplicate: !!p.isDuplicate, width: p.width, height: p.height, isFromDeletedFolder: !!p.isFromDeletedFolder }))
                    });
                    await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error); });
                } catch (e) { console.warn('IDB save failed', e); }
            }, 220);
        }
        async function loadStateIDB() {
            try {
                const db = await openIDB();
                const tx = db.transaction(IDB_STORE, 'readonly');
                const req = tx.objectStore(IDB_STORE).get('last');
                const res = await new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
                if (!res || !res.data || res.scope !== getSessionScope()) return;
                const map = new Map(res.data.map(item => [item.key, item]));
                photos.forEach(photo => {
                    const state = map.get(getPhotoStateKey(photo));
                    if (!state) return;
                    photo.status = state.status;
                    photo.isDuplicate = !!state.isDuplicate;
                    if (state.width) photo.width = state.width;
                    if (state.height) photo.height = state.height;
                    photo.isFromDeletedFolder = !!state.isFromDeletedFolder;
                });
            } catch (e) { console.warn('IDB load failed', e); }
        }

        // Navegación por teclado en la cuadrícula de revisión
        document.addEventListener('keydown', (e) => {
            const grid = document.getElementById('reviewGrid');
            if (!grid || !document.activeElement || !grid.contains(document.activeElement)) return;
            const items = Array.from(grid.querySelectorAll('[role="button"]'));
            const idx = items.indexOf(document.activeElement);
            if (idx < 0) return;
            let next = idx;
            if (e.key === 'ArrowRight') next = Math.min(items.length - 1, idx + 1);
            else if (e.key === 'ArrowLeft') next = Math.max(0, idx - 1);
            else if (e.key === 'ArrowDown') next = Math.min(items.length - 1, idx + 6);
            else if (e.key === 'ArrowUp') next = Math.max(0, idx - 6);
            else return;
            e.preventDefault();
            items[next].focus();
        });

        let toastTimeout;
        function showToast(msg) {
            const toast = document.getElementById('toast');
            document.getElementById('toastMessage').textContent = msg;
            toast.classList.remove('translate-y-20', 'opacity-0');
            
            clearTimeout(toastTimeout);
            toastTimeout = setTimeout(() => {
                toast.classList.add('translate-y-20', 'opacity-0');
            }, 3500);
        }
    
// Expose actions used by the page’s accessible inline controls.
const publicActions = ['showReviewModal', 'loadFolderAuto', 'handleLegacyFiles', 'openLightbox', 'undoLastAction', 'triggerDecision', 'resumeSwiping', 'confirmRestartClassification', 'resetApp', 'switchReviewTab', 'detectDuplicates', 'moveDirectToTrash', 'downloadCleanupScript', 'copyTerminalCommand', 'exportReport', 'exportReportJSON', 'toggleLightboxZoom', 'closeLightbox', 'navigateLightbox', 'setDecisionFromLightbox', 'closeModal'];
Object.assign(window, { showReviewModal, loadFolderAuto, handleLegacyFiles, openLightbox, undoLastAction, triggerDecision, resumeSwiping, confirmRestartClassification, resetApp, switchReviewTab, renderReviewGrid, detectDuplicates, confirmApplyChanges, confirmDirectDelete, moveDirectToTrash, downloadCleanupScript, copyTerminalCommand, exportReport, exportReportJSON, toggleLightboxZoom, closeLightbox, navigateLightbox, setDecisionFromLightbox, closeModal });
Object.defineProperty(window, "currentIndex", { configurable: true, get: () => currentIndex, set: value => { currentIndex = value; } });
Object.defineProperty(window, "reviewSearchQuery", { configurable: true, get: () => reviewSearchQuery, set: value => { reviewSearchQuery = value; } });
// Wire up all UI event listeners (replaces inline onclick/oninput handlers for CSP compliance)
function setupEventListeners() {
    const on = (id, event, handler, opts) => {
        const el = document.getElementById(id);
        if (el) el.addEventListener(event, handler, opts);
    };
    on('btnLoadFolder', 'click', loadFolderAuto);
    on('fileInput', 'change', (e) => handleLegacyFiles(e));
    on('btnHeaderReview', 'click', showReviewModal);
    on('btnCardExpand', 'click', () => openLightbox(currentIndex));
    on('btnCardExpand', 'pointerdown', (e) => e.stopPropagation(), { passive: true });
    on('btnUndo', 'click', undoLastAction);
    on('btnDelete', 'click', () => triggerDecision('delete'));
    on('btnExpandCenter', 'click', () => openLightbox(currentIndex));
    on('btnKeep', 'click', () => triggerDecision('keep'));
    on('btnResumeSwipe', 'click', resumeSwiping);
    on('btnRestartClassification', 'click', confirmRestartClassification);
    on('btnResetApp', 'click', resetApp);
    on('tabDelete', 'click', () => switchReviewTab('delete'));
    on('tabKeep', 'click', () => switchReviewTab('keep'));
    on('tabPending', 'click', () => switchReviewTab('pending'));
    on('btnDetectDuplicates', 'click', detectDuplicates);
    on('reviewSearch', 'input', (e) => { reviewSearchQuery = e.target.value.toLowerCase(); renderReviewGrid(); });
    on('btnMoveToTrash', 'click', () => confirmApplyChanges('direct'));
    on('btnScriptWin', 'click', () => confirmApplyChanges('script', 'win'));
    on('btnScriptMac', 'click', () => confirmApplyChanges('script', 'mac'));
    on('btnCopyTerminal', 'click', copyTerminalCommand);
    on('btnExportCSV', 'click', exportReport);
    on('btnExportJSON', 'click', exportReportJSON);
    on('btnZoomToggle', 'click', toggleLightboxZoom);
    on('btnCloseLightbox', 'click', closeLightbox);
    on('lbImageContainer', 'click', (e) => { if (e.target.id === 'lbImage') toggleLightboxZoom(); });
    on('lbVideo', 'click', (e) => toggleVideoPlayPause(e));
    on('lbMuteBtn', 'click', toggleVideoMute);
    on('btnLightboxPrev', 'click', () => navigateLightbox(-1));
    on('btnLightboxNext', 'click', () => navigateLightbox(1));
    on('btnLightboxDelete', 'click', () => setDecisionFromLightbox('delete'));
    on('btnLightboxKeep', 'click', () => setDecisionFromLightbox('keep'));
    on('btnModalCancel', 'click', closeModal);
}
setupEventListeners();

if (window.IAAlert) { window.__iaAlert = window.IAAlert.mount({ container: document.querySelector("header"), before: document.getElementById("headerControls"), message: "Esta web ha sido generada con IA y no ha sido revisada por un humano.", collapseAfter: 30000, hoverCloseDelay: 5000 }); }
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
