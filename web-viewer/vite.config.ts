import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
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
