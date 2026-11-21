(function (global) {
  'use strict';

  const DEFAULT_MESSAGE = 'Esta web ha sido generada con IA y no ha sido revisada por un humano.';

  function createIcon(size) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('width', size || 22);
    svg.setAttribute('height', size || 22);
    svg.setAttribute('aria-hidden', 'true');
    svg.classList.add('ia-alert-icon');
    svg.innerHTML = '<path stroke-linecap="round" stroke-linejoin="round" d="M12 3 L21.5 19.5 H2.5 Z"></path><line x1="12" y1="9" x2="12" y2="13.5" stroke-linecap="round"></line><circle cx="12" cy="16.5" r="0.9" fill="currentColor" stroke="none"></circle>';
    return svg;
  }

  function isTouchDevice() {
    try { if (window.matchMedia('(hover: none)').matches) return true; } catch (e) { /* ignore */ }
    return 'ontouchstart' in window;
  }

  function mount(options) {
    options = options || {};
    const container = options.container || document.body;
    const before = options.before || null;
    const message = options.message || DEFAULT_MESSAGE;
    const initialOpenMs = typeof options.collapseAfter === 'number' ? options.collapseAfter : 30000;
    const hoverCloseMs = typeof options.hoverCloseDelay === 'number' ? options.hoverCloseDelay : 5000;
    const touch = typeof options.touch === 'boolean' ? options.touch : isTouchDevice();
    if (!container) return null;

    let collapseTimer = null;
    let hoverTimer = null;
    let returnFocus = null;
    let collapseFn;
    let expandFn;
    let isPopupOpen = false;
    const cleanup = [];

    const backdrop = document.createElement('div');
    backdrop.className = 'ia-alert-popup-backdrop';
    backdrop.setAttribute('aria-hidden', 'true');
    const popup = document.createElement('section');
    popup.className = 'ia-alert-popup';
    popup.setAttribute('role', 'dialog');
    popup.setAttribute('aria-modal', 'true');
    popup.setAttribute('aria-labelledby', 'ia-alert-popup-title');
    popup.setAttribute('aria-describedby', 'ia-alert-popup-body');
    const popupHeader = document.createElement('div');
    popupHeader.className = 'ia-alert-popup-header';
    popupHeader.appendChild(createIcon(20));
    const popupTitle = document.createElement('div');
    popupTitle.id = 'ia-alert-popup-title';
    popupTitle.className = 'ia-alert-popup-title';
    popupTitle.textContent = 'Aviso de transparencia';
    popupHeader.appendChild(popupTitle);
    const popupBody = document.createElement('div');
    popupBody.id = 'ia-alert-popup-body';
    popupBody.className = 'ia-alert-popup-body';
    popupBody.textContent = message;
    const popupCloseBtn = document.createElement('button');
    popupCloseBtn.type = 'button';
    popupCloseBtn.className = 'ia-alert-popup-close';
    popupCloseBtn.textContent = 'Entendido';

    function closePopup() {
      if (!isPopupOpen) return;
      isPopupOpen = false;
      backdrop.style.display = 'none';
      backdrop.setAttribute('aria-hidden', 'true');
      document.removeEventListener('keydown', onPopupKeydown);
      if (returnFocus && returnFocus.isConnected) returnFocus.focus();
    }
    function onPopupKeydown(event) {
      if (event.key === 'Escape') { event.preventDefault(); closePopup(); }
    }
    function openPopup() {
      returnFocus = document.activeElement;
      isPopupOpen = true;
      backdrop.style.display = 'flex';
      backdrop.setAttribute('aria-hidden', 'false');
      popupCloseBtn.focus();
      document.addEventListener('keydown', onPopupKeydown);
    }
    popupCloseBtn.addEventListener('click', closePopup);
    backdrop.addEventListener('click', (event) => { if (event.target === backdrop) closePopup(); });
    popup.append(popupHeader, popupBody, popupCloseBtn);
    backdrop.appendChild(popup);
    document.body.appendChild(backdrop);

    function scheduleCollapse(delay) {
      clearTimeout(collapseTimer);
      collapseTimer = setTimeout(() => collapseFn && collapseFn(), delay);
    }

    if (touch) {
      const banner = document.createElement('div');
      banner.className = 'ia-alert-mobile-banner';
      banner.setAttribute('role', 'status');
      banner.appendChild(createIcon(20));
      const copy = document.createElement('div');
      copy.className = 'ia-alert-mobile-copy';
      const title = document.createElement('span');
      title.className = 'ia-alert-mobile-title';
      title.textContent = 'Aviso de transparencia';
      const body = document.createElement('span');
      body.className = 'ia-alert-mobile-text';
      body.textContent = message;
      copy.append(title, body);
      banner.appendChild(copy);
      const bannerClose = document.createElement('button');
      bannerClose.type = 'button';
      bannerClose.className = 'ia-alert-mobile-close';
      bannerClose.setAttribute('aria-label', 'Ocultar aviso');
      bannerClose.textContent = '×';
      banner.appendChild(bannerClose);

      const fab = document.createElement('button');
      fab.type = 'button';
      fab.className = 'ia-alert-fab';
      fab.setAttribute('aria-label', 'Mostrar aviso de transparencia sobre IA');
      fab.title = 'Mostrar aviso de IA';
      fab.appendChild(createIcon(20));
      document.body.append(banner, fab);
      cleanup.push(banner, fab);

      let hideTimer = null;
      expandFn = function () {
        clearTimeout(hideTimer);
        fab.classList.remove('ia-alert-visible');
        banner.classList.remove('ia-alert-hiding');
        banner.style.display = 'flex';
        scheduleCollapse(initialOpenMs);
      };
      collapseFn = function () {
        clearTimeout(collapseTimer);
        clearTimeout(hideTimer);
        banner.classList.add('ia-alert-hiding');
        hideTimer = setTimeout(() => {
          banner.style.display = 'none';
          banner.classList.remove('ia-alert-hiding');
          fab.classList.add('ia-alert-visible');
        }, 260);
      };
      bannerClose.addEventListener('click', collapseFn);
      fab.addEventListener('click', expandFn);
      expandFn();
      cleanup.push(() => clearTimeout(hideTimer));
    } else {
      const host = document.createElement('div');
      host.className = 'ia-alert-host';
      const widget = document.createElement('button');
      widget.type = 'button';
      widget.className = 'ia-alert-widget expanded';
      widget.setAttribute('aria-label', 'Aviso de transparencia sobre el uso de IA');
      widget.setAttribute('aria-expanded', 'true');
      widget.appendChild(createIcon());
      const label = document.createElement('span');
      label.className = 'ia-alert-label';
      label.textContent = 'Aviso IA';
      const text = document.createElement('span');
      text.className = 'ia-alert-text';
      text.textContent = message;
      widget.append(label, text);
      host.appendChild(widget);

      expandFn = function () {
        widget.classList.add('expanded');
        widget.setAttribute('aria-expanded', 'true');
      };
      collapseFn = function () {
        widget.classList.remove('expanded');
        widget.setAttribute('aria-expanded', 'false');
      };
      function onEnter() { clearTimeout(collapseTimer); clearTimeout(hoverTimer); expandFn(); }
      function onLeave() {
        clearTimeout(hoverTimer);
        hoverTimer = setTimeout(() => collapseFn(), hoverCloseMs);
      }
      widget.addEventListener('mouseenter', onEnter);
      widget.addEventListener('mouseleave', onLeave);
      widget.addEventListener('focus', onEnter);
      widget.addEventListener('blur', onLeave);
      widget.addEventListener('click', openPopup);
      if (before && before.parentNode === container) container.insertBefore(host, before);
      else container.appendChild(host);
      cleanup.push(host);
      expandFn();
      scheduleCollapse(initialOpenMs);
    }

    return {
      expand: expandFn,
      collapse: collapseFn,
      openPopup,
      refreshTheme: function () {},
      config: { collapseAfter: initialOpenMs, hoverCloseDelay: hoverCloseMs, touch },
      destroy: function () {
        clearTimeout(collapseTimer);
        clearTimeout(hoverTimer);
        closePopup();
        cleanup.forEach((item) => typeof item === 'function' ? item() : item.remove());
        backdrop.remove();
      },
    };
  }

  global.IAAlert = { mount, isTouchDevice };
})(window);
