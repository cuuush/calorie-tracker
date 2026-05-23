const _toasts = $state([]);

export function toast(message, opts = {}) {
    const id = Date.now() + Math.random();
    const kind = opts.kind || 'info';
    const duration = opts.duration ?? 4000;
    _toasts.push({ id, message, kind });
    setTimeout(() => {
        const i = _toasts.findIndex((t) => t.id === id);
        if (i >= 0) _toasts.splice(i, 1);
    }, duration);
}

export function dismiss(id) {
    const i = _toasts.findIndex((t) => t.id === id);
    if (i >= 0) _toasts.splice(i, 1);
}

export function toasts() {
    return _toasts;
}
