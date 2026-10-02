import { define } from './define.js';

// What the studio says about the agent's runs: why one could not start, and why the studio closed one. The agent's own notes are its
// own words and are never translated.
export const agent = define({
  es: {
    'agent.studioTimeout': 'El runner dejó de informar o se pasó del tiempo máximo de una ejecución, así que Postbay la cerró',
    'agent.blocked.budgetNotSet': 'Pon los presupuestos del agente en Ajustes → Agente para que pueda empezar.',
    'agent.blocked.roundsExhausted': 'El agente ha usado sus {rounds} rondas en esta pieza. A partir de aquí le toca a una persona.',
    'agent.blocked.pieceBudget': 'El agente ha llegado al presupuesto de esta pieza ({spent} de {cap} {currency}).',
    'agent.blocked.monthBudget': 'El agente ha llegado al presupuesto del mes ({spent} de {cap} {currency}, contando lo que aún pueden gastar las ejecuciones en marcha).',
  },
  en: {
    'agent.studioTimeout': 'The runner stopped reporting, or ran past the longest run, so Postbay closed the run',
    'agent.blocked.budgetNotSet': "Set the agent's budgets in Settings → Agent before it can start.",
    'agent.blocked.roundsExhausted': 'The agent has used its {rounds} rounds on this piece. A person has to take it from here.',
    'agent.blocked.pieceBudget': 'The agent has reached the budget for this piece ({spent} of {cap} {currency}).',
    'agent.blocked.monthBudget': "The agent has reached this month's budget ({spent} of {cap} {currency}, counting what runs in progress may still spend).",
  },
});
