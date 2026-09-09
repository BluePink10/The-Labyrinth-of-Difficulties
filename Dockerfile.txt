FROM python:3.11-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py .
COPY static ./static

# Hugging Face Spaces (Docker SDK) обращается к порту 7860.
# Render/Fly.io сами подставляют переменную PORT — если она задана, слушаем её,
# иначе (на HF) используем 7860.
EXPOSE 7860
ENV PORT=7860

CMD ["sh", "-c", "uvicorn app:app --host 0.0.0.0 --port ${PORT}"]
