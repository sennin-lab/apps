import { api } from '../api/endpoints';
import { useAsync } from '../hooks/useAsync';
import { formatPoints } from '../lib/format';
import { navigate } from '../lib/router';

export function HomePage() {
  const { data, error, loading, reload } = useAsync(() => api.bootstrap(), []);

  if (loading) return <div className="center">読み込み中…</div>;
  if (error) {
    return (
      <div className="center">
        <p>{error.message}</p>
        <button onClick={reload}>再読み込み</button>
      </div>
    );
  }
  if (!data) return null;

  const installed = data.items.filter((item) => data.library.includes(item.id));

  return (
    <main className="home">
      <header className="home-header">
        <h1>ホーム</h1>
        {data.me ? (
          <p>{data.me.linked && data.me.points !== null ? formatPoints(data.me.points) : 'ポイント未連携'}</p>
        ) : (
          <a href="/auth/login?next=/next/">仙人アカウントでログイン</a>
        )}
      </header>

      <section className="app-grid" aria-label="入手したアプリ">
        {installed.map((item) => (
          <button key={item.id} className="app-icon" onClick={() => navigate(`/run/${item.id}`)}>
            <span className="app-icon-image">
              {item.icon_url ? <img src={item.icon_url} alt="" /> : null}
            </span>
            <span className="app-icon-title">{item.title}</span>
          </button>
        ))}
      </section>
    </main>
  );
}
