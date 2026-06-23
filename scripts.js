(function () {
  'use strict';

  // Mobile menu
  const toggle = document.querySelector('.menu-toggle');
  const nav = document.getElementById('siteNav');
  if (toggle && nav) {
    toggle.addEventListener('click', function () {
      const open = nav.classList.toggle('open');
      toggle.setAttribute('aria-expanded', String(open));
    });
    nav.addEventListener('click', function (e) {
      if (e.target.tagName === 'A') {
        nav.classList.remove('open');
        toggle.setAttribute('aria-expanded', 'false');
      }
    });
  }

  // Testimonial slider
  const slider = document.querySelector('[data-slider]');
  if (slider) {
    const slides = Array.from(slider.querySelectorAll('.slide'));
    const prev = slider.querySelector('[data-slider-prev]');
    const next = slider.querySelector('[data-slider-next]');
    let cur = 0, timer = null;

    function show(i) {
      slides.forEach((s, idx) => s.classList.toggle('active', idx === i));
      cur = i;
    }
    function advance() { show((cur + 1) % slides.length); }
    function start() { stop(); timer = setInterval(advance, 5000); }
    function stop() { if (timer) { clearInterval(timer); timer = null; } }

    if (prev) prev.addEventListener('click', () => { show((cur - 1 + slides.length) % slides.length); start(); });
    if (next) next.addEventListener('click', () => { advance(); start(); });
    slider.addEventListener('mouseenter', stop);
    slider.addEventListener('mouseleave', start);
    start();
  }

  // Contact form
  document.querySelectorAll('[data-form]').forEach(function (form) {
    const status = form.querySelector('[data-form-status]');
    const btn = form.querySelector('button[type="submit"]');
    const key = form.querySelector('input[name="access_key"]');

    form.addEventListener('submit', async function (e) {
      e.preventDefault();
      if (status) { status.textContent = ''; status.className = 'form-status'; }

      if (!key || !key.value || key.value === 'YOUR_WEB3FORMS_ACCESS_KEY') {
        if (status) { status.textContent = 'Form not configured yet. Email Hello@courtvisionlabs.ai directly.'; status.classList.add('error'); }
        return;
      }

      if (form.querySelector('.honeypot')?.checked) {
        if (status) { status.textContent = 'Thank you!'; status.classList.add('success'); }
        form.reset(); return;
      }

      btn.disabled = true; btn.textContent = 'Sending...';
      try {
        const res = await fetch(form.action, { method: 'POST', body: new FormData(form), headers: { Accept: 'application/json' } });
        const json = await res.json();
        if (res.ok && json.success) {
          if (status) { status.textContent = 'Thank you!'; status.classList.add('success'); }
          form.reset();
        } else {
          if (status) { status.textContent = json.message || 'Something went wrong.'; status.classList.add('error'); }
        }
      } catch {
        if (status) { status.textContent = 'Network error. Try again later.'; status.classList.add('error'); }
      } finally {
        btn.disabled = false; btn.textContent = btn.closest('.contact-form')?.querySelector('[name="subject"]')?.value.includes('Contact') ? 'Send' : 'Submit';
      }
    });
  });
})();
