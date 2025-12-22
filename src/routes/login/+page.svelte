<script>
    import { enhance } from '$app/forms';
    
    let { form } = $props();
    let isLoading = $state(false);
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
        {#if !form?.success}
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
    /* Scoped styles if needed, but most are in app.css */
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
</style>
