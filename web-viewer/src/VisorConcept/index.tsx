import React from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import ConceptViewer from './App';
import type { FileSourceRef } from '../App';

let currentRoot: Root | null = null;

/**
 * Monta el visor en un elemento del DOM.
 *
 * La fuente puede ser un archivo de Drive (por id, que se lee por rangos
 * HTTP) o un File local. En ninguno de los dos casos hace falta tener el
 * archivo entero en memoria: el dibujo mas pesado de la carpeta son 262 MB y
 * solo se leen ~11 MB de el.
 *
 * @param container Elemento del DOM donde renderizar.
 * @param source    De donde salen los bytes del dibujo.
 * @param onClose   Se llama cuando el usuario cierra el visor.
 */
export function mountConceptViewer(
  container: HTMLElement,
  source: FileSourceRef,
  onClose: () => void
) {
  if (currentRoot) {
    currentRoot.unmount();
  }

  currentRoot = createRoot(container);

  currentRoot.render(
    <React.StrictMode>
      <ConceptViewer
        source={source}
        onClose={() => {
          if (currentRoot) {
            currentRoot.unmount();
            currentRoot = null;
          }
          onClose();
        }}
      />
    </React.StrictMode>
  );
}

export { ConceptViewer };
