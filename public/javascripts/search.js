(function () {
  const input = document.querySelector('.input');
  const results = document.querySelector('.users');
  const status = document.querySelector('#searchstatus');
  let activeRequest;

  input.addEventListener('input', async function () {
    if (activeRequest) activeRequest.abort();
    results.replaceChildren();
    status.textContent = '';
    const term = input.value.trim();
    if (!term) return;
    const controller = new AbortController();
    activeRequest = controller;
    status.textContent = 'Searching…';
    try {
      const response = await fetch('/search/' + encodeURIComponent(term), {
        signal: controller.signal, headers: { Accept: 'application/json' }
      });
      if (response.status === 401) { window.location.assign('/login'); return; }
      const users = await response.json();
      if (!response.ok) throw new Error(users.message || 'Search failed');
      if (controller.signal.aborted) return;
      status.textContent = users.length ? '' : 'No users found';
      for (const user of users) {
        const link = document.createElement('a');
        link.href = '/profile/' + encodeURIComponent(user.username);
        link.className = 'outline-none text-white flex items-center gap-2 mt-5';
        const image = document.createElement('img');
        image.src = '/images/uploads/' + encodeURIComponent(user.picture || 'default-avatar.svg');
        image.alt = user.username + ' profile photo';
        image.className = 'w-[11vw] h-[11vw] rounded-full object-cover bg-zinc-300';
        image.addEventListener('error', function () { image.src = '/images/uploads/default-avatar.svg'; }, { once: true });
        const details = document.createElement('div');
        const username = document.createElement('h3');
        username.textContent = user.username;
        const name = document.createElement('h4');
        name.textContent = user.name || '';
        name.className = 'text-xs opacity-30 leading-none';
        details.append(username, name);
        link.append(image, details);
        results.append(link);
      }
    } catch (error) {
      if (controller.signal.aborted) return;
      status.textContent = error.message || 'Could not connect. Please try again';
    }
  });
})();
