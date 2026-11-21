# PhotoSwipe - Notas de mantenimiento

## Tailwind CSS

El proyecto usa **Tailwind CSS con build estático** (no Play CDN). El CSS se genera una vez con el CLI standalone de Tailwind.

### Archivos clave
- `input.css`: Archivo de entrada con `@tailwind` directives
- `tailwind.config.js`: Configuración con content: `['./index.html', './app.js', './ia-alert.js']`
- `tailwind.css`: CSS minificado generado (~26KB)

### Regenerar CSS
Si se agregan nuevas clases de Tailwind al proyecto, hay que regenerar el CSS:

1. Descargar el CLI standalone de Tailwind:
   ```bash
   curl -sLO https://github.com/tailwindlabs/tailwindcss/releases/download/v3.4.17/tailwindcss-linux-x64
   chmod +x tailwindcss-linux-x64
   ```
2. Generar el CSS:
   ```bash
   ./tailwindcss-linux-x64 -i input.css -o tailwind.css --minify
   ```
3. Limpiar:
   ```bash
   rm tailwindcss-linux-x64
   ```

### Importante
- **No usar Play CDN** (`tailwindcss.js`): El build estático es ~93% más pequeño y permite CSP más estricta.
- Si se agregan nuevos archivos HTML/JS, actualizar `content` en `tailwind.config.js`.

## Content Security Policy

El `index.html` tiene CSP configurada con `script-src 'self'` (sin `unsafe-eval`).

### Directivas actuales
```
default-src 'self';
img-src 'self' blob: data:;
media-src 'self' blob:;
worker-src 'self';
style-src 'self' 'unsafe-inline';
script-src 'self'
```

### Notas
- `unsafe-eval` fue eliminado al migrar de Play CDN a build estático.
- `unsafe-inline` en `style-src` es necesario para los estilos inline de Tailwind.
- **No usar `onclick=""` inline en el HTML**: la CSP `script-src 'self'` los bloquea. Todos los event handlers deben usarse con `addEventListener` en `app.js` (ver `setupEventListeners()`).
- Si en el futuro se migran los estilos inline a clases de Tailwind, se podría considerar quitar `unsafe-inline` de `style-src`.

## Service Worker

- Cache name: `photoswiper-v6` (incrementar en cada release que cambie assets)
- Assets cacheados: `./`, `index.html`, `app.js`, `style.css`, `tailwind.css`, `ia-alert.js`, `ia-alert.css`, `duplicate-worker.js`, `thumbnail-worker.js`, `manifest.json`, `icons/icon-192.png`, `icons/icon-512.png`
- Strategy: Cache-first con revalidación en segundo plano
- Si se agregan nuevos archivos estáticos, agregarlos a `ASSETS` en `sw.js`

## Consideraciones de rendimiento

- `duplicate-worker.js`: Tabla de cosenos `DCT_COS` ya precalculada (32×32)
- Detección de duplicados usa banding con Union-Find (no O(n²))
- Estado guardado en IndexedDB con debounce de 220ms (no localStorage)
- Conexión IDB cacheada en `idbPromise`
