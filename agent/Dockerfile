FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY agent.py ./

ENV PORT=8081
EXPOSE 8081

CMD ["python", "agent.py"]
