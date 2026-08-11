/** @type {import('tailwindcss').Config} */
export default {
  content: ["./frontend/index.html", "./frontend/src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        google: {
          text: "#202124",
          muted: "#5f6368",
          blue: "#0b57d0",
          lightBlue: "#eaf1fb",
          search: "#f1f4fc",
          line: "#e7e8ea"
        }
      },
      fontFamily: {
        sans: ["Google Sans", "Roboto", "Noto Sans SC", "PingFang SC", "Microsoft YaHei", "sans-serif"]
      }
    }
  },
  plugins: []
};
