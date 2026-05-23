<script>
    import { fly, fade } from 'svelte/transition';
    import { X } from 'lucide-svelte';
    import { toasts, dismiss } from '$lib/toast.svelte.js';
    const list = toasts();
</script>

<div class="toast-stack">
    {#each list as t (t.id)}
        <div
            class="toast {t.kind}"
            in:fly={{ y: 12, duration: 180 }}
            out:fade={{ duration: 150 }}
        >
            <span class="toast-msg">{t.message}</span>
            <button class="toast-close" onclick={() => dismiss(t.id)} aria-label="Dismiss">
                <X size={14} />
            </button>
        </div>
    {/each}
</div>

<style>
    .toast-stack {
        position: fixed;
        right: 16px;
        bottom: 16px;
        display: flex;
        flex-direction: column;
        gap: 8px;
        z-index: 9000;
        max-width: 320px;
        pointer-events: none;
    }
    .toast {
        background: #181818;
        border: 1px solid #2a2a2a;
        border-radius: 10px;
        padding: 10px 12px;
        display: flex;
        align-items: center;
        gap: 10px;
        font-size: 0.82rem;
        color: #eee;
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
        pointer-events: auto;
    }
    .toast.error {
        border-color: #3a1f1f;
        background: #1a0e0e;
        color: #f4a8a8;
    }
    .toast.success {
        border-color: #1f3a26;
        background: #0e1a10;
        color: #a8e9b5;
    }
    .toast-msg {
        flex: 1;
        line-height: 1.4;
    }
    .toast-close {
        background: transparent;
        border: none;
        color: inherit;
        opacity: 0.6;
        cursor: pointer;
        padding: 2px;
        display: flex;
        align-items: center;
    }
    .toast-close:hover {
        opacity: 1;
    }
</style>
