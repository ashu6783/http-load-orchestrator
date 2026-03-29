for i in {1..20}; do
  curl -s -X POST http://localhost:3000/tests \
    -H "Content-Type: application/json" \
    -H "x-user-id: user-$i" \
    -d "{\"url\": \"https://jsonplaceholder.typicode.com/todos/1\", \"method\": \"GET\", \"payload\": {}, \"requestCount\": 1000, \"concurrency\": 50}" &
done
wait
echo "All 20 requests submitted"