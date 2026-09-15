import "./globals.css";

export const metadata = {
  title: "QA NFT Tool",
  description: "Automated QA Checks for NFT ",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
