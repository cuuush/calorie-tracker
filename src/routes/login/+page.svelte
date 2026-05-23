<script>
    import { enhance } from '$app/forms';
    import { onDestroy } from 'svelte';

    let { form } = $props();
    let isLoading = $state(false);

    let qrMode = $state(false);
    let qrDataUrl = $state('');
    let qrState = $state('idle'); // idle | loading | waiting | approved | denied | expired | rate_limited | error
    let qrError = $state('');
    let secondsLeft = $state(0);

    let deviceSecret = '';
    let qrId = '';
    let pollHandle = null;
    let countdownHandle = null;

    function stopTimers() {
        if (pollHandle) { clearInterval(pollHandle); pollHandle = null; }
        if (countdownHandle) { clearInterval(countdownHandle); countdownHandle = null; }
    }

    async function startQrFlow() {
        stopTimers();
        qrMode = true;
        qrState = 'loading';
        qrError = '';
        qrDataUrl = '';

        try {
            const res = await fetch('/auth/qr/create', { method: 'POST' });
            if (res.status === 429) {
                qrState = 'rate_limited';
                const data = await res.json().catch(() => ({}));
                qrError = data.error || 'Too many requests. Try again later.';
                return;
            }
            if (!res.ok) {
                qrState = 'error';
                qrError = 'Failed to create QR code.';
                return;
            }
            const data = await res.json();
            qrId = data.qr_id;
            deviceSecret = data.device_secret;
            const expiresAt = new Date(data.expires_at).getTime();

            const url = `${window.location.origin}/auth/qr/${qrId}`;
            const QRCode = (await import('qrcode')).default;
            qrDataUrl = await QRCode.toDataURL(url, {
                width: 280,
                margin: 1,
                color: { dark: '#ffffff', light: '#00000000' }
            });

            qrState = 'waiting';

            const tick = () => {
                secondsLeft = Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000));
                if (secondsLeft === 0) {
                    qrState = 'expired';
                    stopTimers();
                }
            };
            tick();
            countdownHandle = setInterval(tick, 1000);

            pollHandle = setInterval(pollStatus, 2000);
        } catch (e) {
            qrState = 'error';
            qrError = 'Network error. Check connection and try again.';
        }
    }

    async function pollStatus() {
        if (!qrId || !deviceSecret) return;
        try {
            const res = await fetch('/auth/qr/status', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ qr_id: qrId, device_secret: deviceSecret })
            });
            if (!res.ok) return;
            const data = await res.json();
            if (data.status === 'approved') {
                qrState = 'approved';
                stopTimers();
                window.location.href = '/';
            } else if (data.status === 'denied') {
                qrState = 'denied';
                stopTimers();
            } else if (data.status === 'expired' || data.status === 'invalid') {
                qrState = 'expired';
                stopTimers();
            }
        } catch (e) {
            // network blip; next poll will retry
        }
    }

    function backToEmail() {
        stopTimers();
        qrMode = false;
        qrState = 'idle';
        qrId = '';
        deviceSecret = '';
        qrDataUrl = '';
    }

    onDestroy(stopTimers);
</script>

{#if isLoading}
    <div id="loadingOverlay" style="display: flex;">
        <div class="spinner"></div>
    </div>
{/if}

<div class="container">
    <header>
        <h1>TRACKER</h1>
    </header>

    <div class="login-container">
        {#if qrMode}
            <h2 class="login-title">SCAN TO SIGN IN</h2>
            <p class="login-subtitle">Open this on your already-signed-in phone and approve.</p>

            <div class="qr-stage">
                {#if qrState === 'loading'}
                    <div class="qr-placeholder">Generating…</div>
                {:else if qrState === 'waiting'}
                    <img class="qr-image" src={qrDataUrl} alt="QR code to sign in" />
                    <p class="qr-countdown">Expires in {secondsLeft}s</p>
                {:else if qrState === 'approved'}
                    <div class="qr-placeholder success">Signed in. Redirecting…</div>
                {:else if qrState === 'denied'}
                    <div class="qr-placeholder">Login denied.</div>
                {:else if qrState === 'expired'}
                    <div class="qr-placeholder">QR expired.</div>
                {:else if qrState === 'rate_limited'}
                    <div class="qr-placeholder">{qrError}</div>
                {:else if qrState === 'error'}
                    <div class="qr-placeholder">{qrError}</div>
                {/if}
            </div>

            {#if qrState === 'denied' || qrState === 'expired' || qrState === 'error'}
                <button type="button" class="login-btn" onclick={startQrFlow}>
                    REGENERATE QR
                </button>
            {/if}

            <button type="button" class="secondary-btn" onclick={backToEmail}>
                Use email instead
            </button>
        {:else if !form?.success}
            <h2 class="login-title">SIGN IN</h2>
            <p class="login-subtitle">Enter your email to receive a link to login</p>

            <form
                method="POST"
                action="?/login"
                use:enhance={() => {
                    isLoading = true;
                    return async ({ update }) => {
                        await update();
                        isLoading = false;
                    };
                }}
                id="loginForm"
            >
                <div class="input-group">
                    <input
                        name="email"
                        type="email"
                        class="login-input"
                        placeholder="your@email.com"
                        required
                        autocomplete="email"
                        value={form?.email ?? ''}
                    >
                </div>

                {#if form?.error}
                    <p style="color: #ff5555; font-size: 0.8rem; margin-top: 10px;">{form.error}</p>
                {/if}

                <button
                    type="submit"
                    class="login-btn"
                    disabled={isLoading}
                >
                    {isLoading ? 'Sending...' : 'Login'}
                </button>
            </form>

            <div class="divider"><span>OR</span></div>

            <button type="button" class="secondary-btn" onclick={startQrFlow}>
                Log in with QR code
            </button>
        {:else}
            <div id="successMessage" class="success-message">
                <p class="success-title">CHECK YOUR EMAIL</p>
                <p class="success-text">We sent a link to <span class="email-display">{form.sentEmail}</span></p>
                <p class="success-expiry">The link expires in 15 minutes</p>
            </div>
        {/if}
    </div>
</div>

<style>
    #loadingOverlay {
        position: fixed;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        background: rgba(0,0,0,0.8);
        z-index: 9999;
        justify-content: center;
        align-items: center;
        display: none;
    }

    .divider {
        display: flex;
        align-items: center;
        margin: 20px 0;
        color: #555;
        font-size: 0.7rem;
        letter-spacing: 2px;
    }
    .divider::before,
    .divider::after {
        content: '';
        flex: 1;
        height: 1px;
        background: #222;
    }
    .divider span {
        padding: 0 12px;
    }

    .secondary-btn {
        width: 100%;
        background: transparent;
        color: #ddd;
        border: 1px solid #333;
        border-radius: 4px;
        padding: 14px;
        font-size: 0.85rem;
        font-weight: 600;
        letter-spacing: 1px;
        cursor: pointer;
        margin-top: 12px;
    }
    .secondary-btn:hover {
        background: #111;
    }

    .qr-stage {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        min-height: 320px;
        margin: 16px 0 12px;
    }
    .qr-image {
        width: 280px;
        height: 280px;
        display: block;
    }
    .qr-placeholder {
        width: 280px;
        height: 280px;
        display: flex;
        align-items: center;
        justify-content: center;
        border: 1px dashed #333;
        color: #777;
        font-size: 0.85rem;
        text-align: center;
        padding: 0 20px;
    }
    .qr-placeholder.success {
        border-color: #1f3a26;
        color: #4ade80;
    }
    .qr-countdown {
        font-size: 0.75rem;
        color: #666;
        margin-top: 12px;
        letter-spacing: 1px;
    }
</style>
