// Runs before first paint so the page never flashes the wrong theme.
(function () {
  var saved = null;
  try {
    saved = localStorage.getItem('sw.theme');
  } catch (e) {}
  var dark = saved ? saved === 'dark' : !window.matchMedia('(prefers-color-scheme: light)').matches;
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
})();
