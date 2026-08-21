import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    // Objetivo minimo real: sin esto Vite 8 usa "baseline-widely-available"
    // (muy moderno) por defecto. La app declara soportar telefonos de gama
    // baja (Android WebView viejo, iOS Safari 14) via device.ts, pero eso
    // nunca se verifico contra el TARGET DE BUILD -- solo contra el
    // comportamiento en Chrome de escritorio con throttling. Si el WebView
    // real no entiende la sintaxis emitida, la app da pantalla en blanco sin
    // que ningun test lo detecte. `tsconfig.app.json` declara target es2023
    // pero tiene `noEmit: true`, o sea que NO afecta el output: solo tipa.
    target: ['chrome87', 'safari14', 'es2020'],
  },
  server: {
    watch: {
      // `.cache/` guarda el corpus de .concepts (varios GB), las capturas de
      // los tests y los perfiles de Chrome que levanta Puppeteer. Vigilarlo no
      // sirve para nada y ademas ROMPE el dev server: en cuanto un test crea su
      // perfil de Chrome ahi adentro, el watcher intenta seguir
      // `Default/Network/Cookies-journal`, Windows lo tiene bloqueado y vite se
      // cae con EBUSY. O sea que correr la bateria mataba el servidor contra el
      // que estaba corriendo.
      ignored: ['**/.cache/**'],
    },
  },
})
