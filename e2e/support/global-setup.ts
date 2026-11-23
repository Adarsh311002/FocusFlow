import { startStack, stopStack } from './stack';

export default async function globalSetup(): Promise<() => Promise<void>> {
  try {
    await startStack();
  } catch (error) {
    await stopStack();
    throw error;
  }
  return stopStack;
}
