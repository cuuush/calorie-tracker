<script>
    import { onMount } from 'svelte';
    
    let email = '';
    let isLoading = false;
    let isSuccess = false;
    let sentEmail = '';

    async function login() {
        if (!email || isLoading) return;
        
        isLoading = true;
        try {
            const res = await fetch('/auth/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email })
            });
            const data = await res.json();
            
            if (data.success) {
                isSuccess = true;
                sentEmail = email;
            } else {
                alert(data.error || 'Failed to send login link');
            }
        } catch (e) {
            console.error(e);
            alert('Something went wrong');
        } finally {
            isLoading = false;
        }
    }
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
        {#if !isSuccess}
            <h2 class="login-title">SIGN IN</h2>
            <p class="login-subtitle">Enter your email to receive a link to login</p>

            <div id="loginForm">
                <div class="input-group">
                    <input
                        type="email"
                        bind:value={email}
                        class="login-input"
                        placeholder="your@email.com"
                        onkeypress={(e) => e.key === 'Enter' && login()}
                        autocomplete="email"
                    >
                </div>

                <button
                    onclick={login}
                    class="login-btn"
                >
                    Login
                </button>
            </div>
        {:else}
            <div id="successMessage" class="success-message">
                <p class="success-title">CHECK YOUR EMAIL</p>
                <p class="success-text">We sent a link to <span class="email-display">{sentEmail}</span></p>
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
