// Hook de resolucion para poder importar el codigo de `src/` desde node.
//
// El codigo de la app importa sin extension (`./zip`), que es lo que Vite
// resuelve solo. El cargador de node exige la extension, asi que sin esto no se
// puede testear el parser REAL desde un script — habria que reimplementarlo, y
// entonces el test dejaria de probar lo que se publica.
//
//   node --experimental-strip-types --import ./scripts/_hooks-ts.mjs <script>
import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith(".") && !/\.[a-z]+$/i.test(specifier) && context.parentURL) {
      const base = fileURLToPath(new URL(specifier, context.parentURL));
      for (const ext of [".ts", ".tsx", ".js", ".mjs"]) {
        if (existsSync(base + ext)) return nextResolve(specifier + ext, context);
      }
    }
    return nextResolve(specifier, context);
  },
});
