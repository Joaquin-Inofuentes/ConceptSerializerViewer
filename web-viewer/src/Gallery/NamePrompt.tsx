import { useState } from "react";
import { m } from "motion/react";
import "./Gallery.css";

interface NamePromptProps {
  onSubmit: (name: string) => void;
}

const EASE_IOS: [number, number, number, number] = [0.16, 1, 0.3, 1];

export function NamePrompt({ onSubmit }: NamePromptProps) {
  const [value, setValue] = useState("");

  const submit = () => {
    onSubmit(value.trim() || "Invitado");
  };

  return (
    <m.div
      className="gallery-modal-overlay"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.5, ease: EASE_IOS }}
      style={{ zIndex: 500 }}
    >
      <m.div
        className="gallery-modal"
        initial={{ opacity: 0, scale: 0.92, y: 16 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        transition={{ type: "spring", stiffness: 300, damping: 26 }}
      >
        <h3>Como te llamas?</h3>
        <p>Se usa para identificar tus dibujos y tus descargas.</p>
        <input
          type="text"
          className="gallery-name-input"
          placeholder="Tu nombre"
          value={value}
          autoFocus
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
        />
        <button className="gallery-toolbar-btn primary gallery-name-submit" onClick={submit}>
          Continuar
        </button>
        <button className="gallery-modal-cancel" onClick={() => onSubmit("Invitado")}>
          Continuar sin nombre
        </button>
      </m.div>
    </m.div>
  );
}

export default NamePrompt;
