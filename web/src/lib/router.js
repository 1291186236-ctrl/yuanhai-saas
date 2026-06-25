const routes = {};
let currentCleanup = null;

function register(path, handler) {
    routes[path] = handler;
}

function navigate(path) {
    window.location.hash = '#' + path;
}

function getHash() {
    return window.location.hash.slice(1) || '/login';
}

async function handleRoute() {
    if (currentCleanup) {
        currentCleanup();
        currentCleanup = null;
    }

    const hash = getHash();
    const [path] = hash.split('?');

    const handler = routes[path];
    if (handler) {
        const cleanup = await handler();
        if (typeof cleanup === 'function') {
            currentCleanup = cleanup;
        }
    } else {
        const app = document.getElementById('app');
        app.innerHTML = '<div class="not-found"><h1>404</h1><p>页面不存在</p></div>';
    }
}

function startRouter() {
    window.addEventListener('hashchange', handleRoute);
    handleRoute();
}

export { register, navigate, startRouter, getHash };
