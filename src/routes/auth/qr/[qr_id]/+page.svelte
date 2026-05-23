<script>
    import { enhance } from '$app/forms';
    let { data, form } = $props();
    let submitting = $state(false);
</script>

<div class="container">
    <header>
        <h1>TRACKER</h1>
    </header>

    <div class="qr-approve">
        {#if form?.approved}
            <div class="result-card success">
                <p class="result-title">LOGIN APPROVED</p>
                <p class="result-text">Return to your other device. You should be signed in within a couple of seconds.</p>
            </div>
        {:else if form?.denied}
            <div class="result-card">
                <p class="result-title">LOGIN DENIED</p>
                <p class="result-text">The sign-in request was rejected.</p>
            </div>
        {:else if data.state === 'expired'}
            <div class="result-card">
                <p class="result-title">LINK EXPIRED</p>
                <p class="result-text">This QR code expired or doesn't exist. Generate a new one on your other device.</p>
            </div>
        {:else if data.state === 'already_approved'}
            <div class="result-card">
                <p class="result-title">ALREADY APPROVED</p>
                <p class="result-text">This sign-in request was already approved.</p>
            </div>
        {:else if data.state === 'already_denied'}
            <div class="result-card">
                <p class="result-title">ALREADY DENIED</p>
                <p class="result-text">This sign-in request was already denied.</p>
            </div>
        {:else}
            <p class="approve-title">SIGN IN ON ANOTHER DEVICE?</p>
            <p class="approve-sub">A device is asking to sign in as <span class="approve-email">{data.email}</span></p>

            <div class="device-card">
                <div class="device-row">
                    <span class="device-label">DEVICE</span>
                    <span class="device-value">{data.device}</span>
                </div>
                {#if data.ip}
                    <div class="device-row">
                        <span class="device-label">IP</span>
                        <span class="device-value">{data.ip}{data.country ? ` · ${data.country}` : ''}</span>
                    </div>
                {/if}
            </div>

            <p class="approve-warning">Only approve if this is you. Approving will sign that device into your account.</p>

            <div class="approve-actions">
                <form method="POST" action="?/deny" use:enhance={() => {
                    submitting = true;
                    return async ({ update }) => { await update(); submitting = false; };
                }}>
                    <button type="submit" class="btn-deny" disabled={submitting}>DENY</button>
                </form>
                <form method="POST" action="?/approve" use:enhance={() => {
                    submitting = true;
                    return async ({ update }) => { await update(); submitting = false; };
                }}>
                    <button type="submit" class="btn-approve" disabled={submitting}>APPROVE</button>
                </form>
            </div>

            {#if form?.error}
                <p class="approve-error">{form.error}</p>
            {/if}
        {/if}
    </div>
</div>

<style>
    .qr-approve {
        max-width: 420px;
        margin: 40px auto;
        padding: 0 20px;
    }
    .approve-title {
        font-size: 1rem;
        font-weight: 600;
        letter-spacing: 2px;
        margin: 0 0 8px;
    }
    .approve-sub {
        font-size: 0.85rem;
        color: #aaa;
        margin: 0 0 24px;
    }
    .approve-email {
        color: #eee;
        font-weight: 600;
    }
    .device-card {
        border: 1px solid #2a2a2a;
        border-radius: 8px;
        padding: 16px;
        margin-bottom: 20px;
    }
    .device-row {
        display: flex;
        justify-content: space-between;
        padding: 6px 0;
    }
    .device-label {
        font-size: 0.7rem;
        color: #666;
        letter-spacing: 1px;
    }
    .device-value {
        font-size: 0.85rem;
        color: #eee;
    }
    .approve-warning {
        font-size: 0.75rem;
        color: #888;
        margin: 16px 0 28px;
        line-height: 1.5;
    }
    .approve-actions {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 12px;
    }
    .approve-actions form {
        margin: 0;
    }
    .btn-approve, .btn-deny {
        width: 100%;
        min-height: 52px;
        font-size: 0.9rem;
        font-weight: 700;
        letter-spacing: 2px;
        border-radius: 8px;
        border: none;
        cursor: pointer;
    }
    .btn-approve {
        background: #4ade80;
        color: #000;
    }
    .btn-approve:disabled {
        opacity: 0.5;
    }
    .btn-deny {
        background: transparent;
        color: #aaa;
        border: 1px solid #333;
    }
    .approve-error {
        color: #ff5555;
        font-size: 0.8rem;
        margin-top: 14px;
    }
    .result-card {
        border: 1px solid #2a2a2a;
        border-radius: 8px;
        padding: 24px;
        text-align: center;
    }
    .result-card.success {
        border-color: #1f3a26;
    }
    .result-title {
        font-size: 0.95rem;
        font-weight: 700;
        letter-spacing: 2px;
        margin: 0 0 12px;
    }
    .result-text {
        font-size: 0.85rem;
        color: #aaa;
        line-height: 1.5;
        margin: 0;
    }
</style>
