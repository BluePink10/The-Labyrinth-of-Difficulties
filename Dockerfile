FROM python:3.11-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py .
COPY static ./static

# Значение по умолчанию для локального запуска или HF Spaces
ENV PORT=7860

# Запуск с подстановкой PORT из окружения (Render переопределит его сам)
CMD ["sh", "-c", "uvicorn app:app --host 0.0.0.0 --port ${PORT}"]