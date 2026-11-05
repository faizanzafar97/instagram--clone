(function () {
  const links = document.querySelectorAll('.notification-link');
  let pending = false;

  function badge(count) {
    links.forEach(link => {
      const indicator = link.querySelector('.notification-badge');
      indicator.hidden = count === 0;
      indicator.textContent = count > 99 ? '99+' : String(count);
      link.setAttribute('aria-label', count ? 'Notifications, ' + count + ' unread' : 'Notifications');
    });
  }

  async function request(url, method = 'GET') {
    const response = await fetch(url, { method, headers: { Accept: 'application/json' }, cache: 'no-store' });
    if (response.status === 401) {
      window.location.assign('/login');
      throw new Error('Please log in to continue');
    }
    const result = await response.json();
    if (!response.ok) throw new Error(result.message || 'Could not update notifications');
    return result;
  }

  async function refresh() {
    if (pending || document.hidden) return;
    pending = true;
    try { badge((await request('/notifications/unread-count')).unreadCount); }
    catch (_) { /* Keep the last count when the connection is interrupted. */ }
    finally { pending = false; }
  }

  function read(item) {
    item.dataset.read = 'true';
    item.querySelector('.notification-unread').hidden = true;
  }

  const form = document.querySelector('.mark-notifications-read');
  const errorMessage = document.querySelector('.notifications-error');
  if (form) {
    form.addEventListener('submit', async function (event) {
      event.preventDefault();
      const button = form.querySelector('button');
      if (button.disabled) return;
      button.disabled = true;
      errorMessage.hidden = true;
      try {
        const result = await request('/notifications/read', 'POST');
        document.querySelectorAll('.notification-item').forEach(read);
        badge(result.unreadCount);
        document.querySelector('.notifications-status').textContent = 'All notifications marked as read.';
      } catch (error) {
        errorMessage.textContent = error.message || 'Could not connect. Please try again';
        errorMessage.hidden = false;
      } finally { button.disabled = false; }
    });
    document.querySelector('.notification-list').addEventListener('click', async function (event) {
      const link = event.target.closest('.notification-open');
      if (!link || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      const item = link.closest('.notification-item');
      if (item.dataset.read === 'true') return;
      event.preventDefault();
      if (item.dataset.pending) return;
      item.dataset.pending = 'true';
      errorMessage.hidden = true;
      try {
        await request('/notifications/' + encodeURIComponent(item.dataset.notificationid) + '/read', 'POST');
        read(item);
        window.location.assign(link.href);
      } catch (error) {
        errorMessage.textContent = error.message || 'Could not connect. Please try again';
        errorMessage.hidden = false;
      } finally { delete item.dataset.pending; }
    });
  }
  refresh();
  window.setInterval(refresh, 30000);
  window.addEventListener('focus', refresh);
  document.addEventListener('visibilitychange', refresh);
})();
