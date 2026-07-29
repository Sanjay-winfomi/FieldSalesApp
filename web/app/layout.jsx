// Root layout — replaces the old index.html shell (index.html itself is
// removed under the App Router; Next.js generates the document from here).
// Kept as a Server Component: it renders no interactive UI itself, it only
// sets up <head> and loads the global stylesheet, so it needs no 'use client'.
import '../src/index.css';

export const metadata = {
  title: 'Winfomi Field Track',
  icons: {
    icon: '/favicon.png',
  },
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>
        <div id="root">{children}</div>
      </body>
    </html>
  );
}
