const $ = id => document.getElementById(id);

async function login() {
  const email = $('emailInput').value.trim();

  if (!email || !email.includes('@')) {
    alert('Please enter a valid email address');
    return;
  }

  $('loadingOverlay').style.display = 'flex';

  try {
    const res = await fetch('/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email })
    });

    const data = await res.json();

    if (res.ok && data.success) {
      $('loginForm').classList.add('hidden');
      $('successMessage').classList.remove('hidden');
      $('emailSent').textContent = email;
    } else {
      alert(data.error || 'Failed to send login link. Please try again.');
    }
  } catch (e) {
    console.error('Login error:', e);
    alert('Network error. Please try again.');
  } finally {
    $('loadingOverlay').style.display = 'none';
  }
}
