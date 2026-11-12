"""Small helpers shared by every module that talks to Ollama."""

from __future__ import annotations


def chat_without_thinking(client, **kwargs):
    """`client.chat(...)` with reasoning switched off where the client supports it.

    Reasoning tokens share `num_predict` with the reply, so a thinking model asked
    for prose or JSON can spend the whole budget before writing any of it. Older
    ollama-python releases have no `think` parameter and raise TypeError on it;
    they get the plain call.
    """
    try:
        return client.chat(think=False, **kwargs)
    except TypeError:
        return client.chat(**kwargs)
