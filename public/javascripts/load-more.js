(function () {
  const button = document.querySelector('#loadmore');
  const posts = document.querySelector('.posts.parent');
  const status = document.querySelector('#loadmorestatus');
  const errorMessage = document.querySelector('#loadmoreerror');

  button.addEventListener('click', async function () {
    if (button.disabled || !button.dataset.cursor) return;
    button.disabled = true;
    button.textContent = 'Loading…';
    posts.setAttribute('aria-busy', 'true');
    errorMessage.hidden = true;
    status.textContent = 'Loading more posts…';
    try {
      const response = await fetch('/feed?before=' + encodeURIComponent(button.dataset.cursor), {
        headers: { Accept: 'application/json' }, cache: 'no-store'
      });
      if (response.status === 401) { window.location.assign('/login'); return; }
      const result = await response.json();
      if (!response.ok) throw new Error(result.message || 'Could not load more posts');
      if (result.userId !== posts.dataset.userid) { window.location.assign('/feed'); return; }
      const fragment = document.createElement('template');
      fragment.innerHTML = result.html;
      const existing = new Set(Array.from(posts.querySelectorAll('.post'), post => post.dataset.postid));
      let added = 0;
      fragment.content.querySelectorAll('.post').forEach(post => {
        if (existing.has(post.dataset.postid)) return;
        existing.add(post.dataset.postid);
        posts.append(post);
        added++;
      });
      if (added) posts.querySelector('.feedempty')?.remove();
      button.dataset.cursor = result.nextCursor || '';
      button.hidden = !result.nextCursor;
      status.textContent = result.nextCursor ? 'Loaded ' + added + ' more posts.' : 'You’re all caught up.';
      if (button.hidden) { status.tabIndex = -1; status.focus(); }
    } catch (error) {
      status.textContent = '';
      errorMessage.textContent = error.message || 'Could not connect. Please try again';
      errorMessage.hidden = false;
    } finally {
      button.disabled = false;
      button.textContent = 'Load more';
      posts.setAttribute('aria-busy', 'false');
    }
  });
})();
