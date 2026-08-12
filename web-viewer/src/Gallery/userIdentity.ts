const KEY = "conceptserializer_user_name";

export function getUserName(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function setUserName(name: string): void {
  try {
    localStorage.setItem(KEY, name);
  } catch {
    // localStorage no disponible (modo privado, etc.): seguimos sin persistir.
  }
}
